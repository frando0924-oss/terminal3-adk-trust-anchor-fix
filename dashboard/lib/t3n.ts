// SERVER-ONLY. Never import this file from a client component ("use
// client") -- it holds the tenant's own T3N_API_KEY (and, for revoke, the
// agent's own AGENT_KEY) and uses them to talk directly to the Terminal 3
// TEE contract. The browser never sees this file or its credentials; the
// only callers are the API route handlers under app/api/* (ledger, reset,
// revoke, events).
//
// Three functions matter most here:
//   - readLedger()   -- fetches the contract's ledger snapshot (spend so
//                       far, policy, and every payment attempt). This is
//                       the enclave's own record, independent of whatever
//                       the agent self-reports (see app/api/events).
//   - resetBudget()  -- zeroes the session's running total, for re-running
//                       a demo without waiting for a new session.
//   - revokeAgent()  -- the dashboard's "Revoke" button. Its real effect is
//                       narrower than it sounds: it clears the agent's
//                       allowedHosts grant on the contract. It does NOT
//                       flip some data-plane toggle or kill a connection --
//                       it's a live capability revocation. The agent keeps
//                       whatever it already has in memory and can still
//                       *call* pay-for-service, but the *next* payment
//                       attempt fails at the enclave's own egress check
//                       (host/http.egress_denied) because the contract will
//                       no longer let its outbound call reach the relay.
//                       See the comment inside revokeAgent() below for the
//                       exact mechanics.
//
// Server-side ONLY -- never imported from a client component. Holds the
// tenant's own T3N_API_KEY to read the contract's get-ledger and to run
// revoke/reset control calls. The browser never sees this file or its
// credentials; API routes are the only callers.
//
// MOCK_T3N=1 is a dashboard-local-dev convenience distinct from MOCK_CIRCLE:
// it lets the dashboard run and be screenshotted without real Terminal 3
// credentials, using an in-memory ledger instead. This is lower-risk than a
// similar bypass would be in the agent's payment path (dashboard reads never
// move money), but it is still dev-only -- the deployed production dashboard
// always has real T3N_API_KEY/T3N_TENANT_DID set.
import {
  T3nClient,
  TenantClient,
  setEnvironment,
  loadWasmComponent,
  eth_get_address,
  metamask_sign,
  createEthAuthInput,
  fetchTrustedManifest,
  getScriptVersion,
  getNodeUrl,
} from "@terminal3/t3n-sdk";

const MOCK_T3N = process.env.MOCK_T3N === "1";
const CONTRACT_TAIL = process.env.CONTRACT_TAIL ?? "guarded-commerce";

export interface LedgerEntry {
  seq: number;
  ts: number;
  service_url: string;
  amount_usdc: number;
  status: "paid" | "denied" | "failed";
  reason?: string;
  remaining_budget?: number;
  idempotency_key: string;
  relay_ref?: string;
}

export interface LedgerSnapshot {
  running_total: number;
  session_budget: number;
  per_call_cap: number;
  host_allowlist: string[];
  entries: LedgerEntry[];
  revoked?: boolean;
  // Count of stored entries the contract found but couldn't parse -- see
  // ledger.rs's read_all_entries(). Always 0 in mock mode.
  malformed_entries?: number;
}

// --- Mock backend: in-memory, process-wide singleton via `globalThis`.
// Next.js dev mode compiles each API route as a separate module bundle, so a
// plain module-scoped `const` here would NOT be shared across
// /api/ledger, /api/events, /api/revoke, /api/reset -- each route would see
// its own independent instance and mutations would silently not cross over.
// Stashing it on `globalThis` survives across those separate bundles within
// the same process (the standard fix for this exact Next.js dev gotcha,
// same pattern used for e.g. a shared Prisma client). ---
declare global {
  // eslint-disable-next-line no-var
  var __guardedCommerceMockLedger: LedgerSnapshot | undefined;
}

function getMockState(): LedgerSnapshot {
  if (!globalThis.__guardedCommerceMockLedger) {
    globalThis.__guardedCommerceMockLedger = {
      running_total: 0,
      session_budget: Number(process.env.SESSION_BUDGET_USDC ?? "1.0"),
      per_call_cap: Number(process.env.PER_CALL_CAP_USDC ?? "0.05"),
      host_allowlist: [new URL(process.env.RELAY_BASE_URL ?? "http://localhost:8787").host],
      entries: [],
      revoked: false,
    };
  }
  return globalThis.__guardedCommerceMockLedger;
}

function tenantScriptName(tenantDid: string): string {
  return `z:${tenantDid.slice("did:t3n:".length)}:${CONTRACT_TAIL}`;
}

let cachedTenant: Promise<{ t3n: T3nClient; tenant: TenantClient; tenantDid: string }> | null = null;

async function getTenant() {
  if (!cachedTenant) {
    cachedTenant = (async () => {
      const T3N_API_KEY = requireEnv("T3N_API_KEY");
      const environment = (process.env.T3N_ENVIRONMENT as "sandbox" | "testnet" | "production") ?? "testnet";
      setEnvironment(environment);
      const wasmComponent = await loadWasmComponent();
      const address = eth_get_address(T3N_API_KEY);
      const trustAnchor = process.env.T3N_UNSAFE_TRUST_SERVER === "1"
        ? { unsafe_trust_server: true as const }
        : await fetchTrustedManifest(environment);
      const t3n = new T3nClient({
        wasmComponent,
        handlers: { EthSign: metamask_sign(address, undefined, T3N_API_KEY) },
        trustAnchor,
      });
      await t3n.handshake();
      const did = await t3n.authenticate(createEthAuthInput(address));
      const tenant = new TenantClient({ t3n, baseUrl: getNodeUrl(), tenantDid: did.value });
      return { t3n, tenant, tenantDid: did.value };
    })();
  }
  return cachedTenant;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see docs/DEVELOPER_BUILD_LOG.md §4)`);
  return value;
}

export async function readLedger(): Promise<LedgerSnapshot> {
  if (MOCK_T3N) return getMockState();

  const { t3n, tenantDid } = await getTenant();
  const scriptName = tenantScriptName(tenantDid);
  const scriptVersion = await getScriptVersion(getNodeUrl(), scriptName);
  return t3n.executeAndDecode<LedgerSnapshot>({
    script_name: scriptName,
    script_version: scriptVersion,
    function_name: "get-ledger",
    input: {},
  });
}

export async function resetBudget(): Promise<void> {
  if (MOCK_T3N) {
    getMockState().running_total = 0;
    return;
  }
  const { tenant } = await getTenant();
  await tenant.executeControl("map-entry-set", {
    map_name: tenant.canonicalName("ledger"),
    key: "running_total",
    value: "0",
  });
}

export async function revokeAgent(): Promise<void> {
  if (MOCK_T3N) {
    getMockState().revoked = true;
    return;
  }
  const AGENT_KEY = requireEnv("AGENT_KEY");
  const environment = (process.env.T3N_ENVIRONMENT as "sandbox" | "testnet" | "production") ?? "testnet";
  setEnvironment(environment);
  const wasmComponent = await loadWasmComponent();
  const agentAddress = eth_get_address(AGENT_KEY);
  const trustAnchor = process.env.T3N_UNSAFE_TRUST_SERVER === "1"
    ? { unsafe_trust_server: true as const }
    : await fetchTrustedManifest(environment);
  const agentT3n = new T3nClient({
    wasmComponent,
    handlers: { EthSign: metamask_sign(agentAddress, undefined, AGENT_KEY) },
    trustAnchor,
  });
  await agentT3n.handshake();
  const agentDid = (await agentT3n.authenticate(createEthAuthInput(agentAddress))).value;

  const { t3n, tenantDid } = await getTenant();
  // functions: [] is REJECTED by the node ("functions must not be empty (use
  // [\"*\"] for all functions)") -- confirmed against live infrastructure.
  // Clear allowedHosts only, keeping functions valid: the agent can still
  // call pay-for-service, but its outbound call to the relay fails with
  // host/http.egress_denied. See docs/DEVELOPER_BUILD_LOG.md §3t.
  await t3n.updateAgentAuth(agentDid, {
    scriptName: tenantScriptName(tenantDid),
    versionReq: null,
    functions: ["pay-for-service", "get-ledger"],
    allowedHosts: [],
  });
}

// Only used by the mock path -- lets the /api/events route append the
// agent's own self-reported outcomes into the same in-memory snapshot the
// dashboard reads, so mock mode has something to render end to end.
export function mockAppendEntry(entry: LedgerEntry): void {
  if (!MOCK_T3N) return;
  const state = getMockState();
  state.entries.push(entry);
  if (entry.status === "paid") state.running_total += entry.amount_usdc;
}
// SERVER-ONLY. Never import this file from a client component ("use
// client") -- it holds the tenant's own T3N_API_KEY (and, for revoke, the
// agent's own AGENT_KEY) and uses them to talk directly to the Terminal 3
// TEE contract. The browser never sees this file or its credentials; the
// only callers are the API route handlers under app/api/* (ledger, reset,
// revoke, events).
//
// Three functions matter most here:
//   - readLedger()   -- fetches the contract's ledger snapshot (spend so
//                       far, policy, and every payment attempt). This is
//                       the enclave's own record, independent of whatever
//                       the agent self-reports (see app/api/events).
//   - resetBudget()  -- zeroes the session's running total, for re-running
//                       a demo without waiting for a new session.
//   - revokeAgent()  -- the dashboard's "Revoke" button. Its real effect is
//                       narrower than it sounds: it clears the agent's
//                       allowedHosts grant on the contract. It does NOT
//                       flip some data-plane toggle or kill a connection --
//                       it's a live capability revocation. The agent keeps
//                       whatever it already has in memory and can still
//                       *call* pay-for-service, but the *next* payment
//                       attempt fails at the enclave's own egress check
//                       (host/http.egress_denied) because the contract will
//                       no longer let its outbound call reach the relay.
//                       See the comment inside revokeAgent() below for the
//                       exact mechanics.
//
// Server-side ONLY -- never imported from a client component. Holds the
// tenant's own T3N_API_KEY to read the contract's get-ledger and to run
// revoke/reset control calls. The browser never sees this file or its
// credentials; API routes are the only callers.
//
// MOCK_T3N=1 is a dashboard-local-dev convenience distinct from MOCK_CIRCLE:
// it lets the dashboard run and be screenshotted without real Terminal 3
// credentials, using an in-memory ledger instead. This is lower-risk than a
// similar bypass would be in the agent's payment path (dashboard reads never
// move money), but it is still dev-only -- the deployed production dashboard
// always has real T3N_API_KEY/T3N_TENANT_DID set.
import {
  T3nClient,
  TenantClient,
  setEnvironment,
  loadWasmComponent,
  eth_get_address,
  metamask_sign,
  createEthAuthInput,
  getScriptVersion,
  getNodeUrl,
} from "@terminal3/t3n-sdk";

const MOCK_T3N = process.env.MOCK_T3N === "1";
const CONTRACT_TAIL = process.env.CONTRACT_TAIL ?? "guarded-commerce";

export interface LedgerEntry {
  seq: number;
  ts: number;
  service_url: string;
  amount_usdc: number;
  status: "paid" | "denied" | "failed";
  reason?: string;
  remaining_budget?: number;
  idempotency_key: string;
  relay_ref?: string;
}

export interface LedgerSnapshot {
  running_total: number;
  session_budget: number;
  per_call_cap: number;
  host_allowlist: string[];
  entries: LedgerEntry[];
  revoked?: boolean;
  // Count of stored entries the contract found but couldn't parse -- see
  // ledger.rs's read_all_entries(). Always 0 in mock mode.
  malformed_entries?: number;
}

// --- Mock backend: in-memory, process-wide singleton via `globalThis`.
// Next.js dev mode compiles each API route as a separate module bundle, so a
// plain module-scoped `const` here would NOT be shared across
// /api/ledger, /api/events, /api/revoke, /api/reset -- each route would see
// its own independent instance and mutations would silently not cross over.
// Stashing it on `globalThis` survives across those separate bundles within
// the same process (the standard fix for this exact Next.js dev gotcha,
// same pattern used for e.g. a shared Prisma client). ---
declare global {
  // eslint-disable-next-line no-var
  var __guardedCommerceMockLedger: LedgerSnapshot | undefined;
}

function getMockState(): LedgerSnapshot {
  if (!globalThis.__guardedCommerceMockLedger) {
    globalThis.__guardedCommerceMockLedger = {
      running_total: 0,
      session_budget: Number(process.env.SESSION_BUDGET_USDC ?? "1.0"),
      per_call_cap: Number(process.env.PER_CALL_CAP_USDC ?? "0.05"),
      host_allowlist: [new URL(process.env.RELAY_BASE_URL ?? "http://localhost:8787").host],
      entries: [],
      revoked: false,
    };
  }
  return globalThis.__guardedCommerceMockLedger;
}

function tenantScriptName(tenantDid: string): string {
  return `z:${tenantDid.slice("did:t3n:".length)}:${CONTRACT_TAIL}`;
}

let cachedTenant: Promise<{ t3n: T3nClient; tenant: TenantClient; tenantDid: string }> | null = null;

async function getTenant() {
  if (!cachedTenant) {
    cachedTenant = (async () => {
      const T3N_API_KEY = requireEnv("T3N_API_KEY");
      setEnvironment((process.env.T3N_ENVIRONMENT as "sandbox" | "testnet" | "production") ?? "testnet");
      const wasmComponent = await loadWasmComponent();
      const address = eth_get_address(T3N_API_KEY);
      const t3n = new T3nClient({
        wasmComponent,
        handlers: { EthSign: metamask_sign(address, undefined, T3N_API_KEY) },
      });
      await t3n.handshake();
      const did = await t3n.authenticate(createEthAuthInput(address));
      const tenant = new TenantClient({ t3n, baseUrl: getNodeUrl(), tenantDid: did.value });
      return { t3n, tenant, tenantDid: did.value };
    })();
  }
  return cachedTenant;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see docs/DEVELOPER_BUILD_LOG.md §4)`);
  return value;
}

export async function readLedger(): Promise<LedgerSnapshot> {
  if (MOCK_T3N) return getMockState();

  const { t3n, tenantDid } = await getTenant();
  const scriptName = tenantScriptName(tenantDid);
  const scriptVersion = await getScriptVersion(getNodeUrl(), scriptName);
  return t3n.executeAndDecode<LedgerSnapshot>({
    script_name: scriptName,
    script_version: scriptVersion,
    function_name: "get-ledger",
    input: {},
  });
}

export async function resetBudget(): Promise<void> {
  if (MOCK_T3N) {
    getMockState().running_total = 0;
    return;
  }
  const { tenant } = await getTenant();
  await tenant.executeControl("map-entry-set", {
    map_name: tenant.canonicalName("ledger"),
    key: "running_total",
    value: "0",
  });
}

export async function revokeAgent(): Promise<void> {
  if (MOCK_T3N) {
    getMockState().revoked = true;
    return;
  }
  const AGENT_KEY = requireEnv("AGENT_KEY");
  setEnvironment((process.env.T3N_ENVIRONMENT as "sandbox" | "testnet" | "production") ?? "testnet");
  const wasmComponent = await loadWasmComponent();
  const agentAddress = eth_get_address(AGENT_KEY);
  const agentT3n = new T3nClient({
    wasmComponent,
    handlers: { EthSign: metamask_sign(agentAddress, undefined, AGENT_KEY) },
  });
  await agentT3n.handshake();
  const agentDid = (await agentT3n.authenticate(createEthAuthInput(agentAddress))).value;

  const { t3n, tenantDid } = await getTenant();
  // functions: [] is REJECTED by the node ("functions must not be empty (use
  // [\"*\"] for all functions)") -- confirmed against live infrastructure.
  // Clear allowedHosts only, keeping functions valid: the agent can still
  // call pay-for-service, but its outbound call to the relay fails with
  // host/http.egress_denied. See docs/DEVELOPER_BUILD_LOG.md §3t.
  await t3n.updateAgentAuth(agentDid, {
    scriptName: tenantScriptName(tenantDid),
    versionReq: null,
    functions: ["pay-for-service", "get-ledger"],
    allowedHosts: [],
  });
}

// Only used by the mock path -- lets the /api/events route append the
// agent's own self-reported outcomes into the same in-memory snapshot the
// dashboard reads, so mock mode has something to render end to end.
export function mockAppendEntry(entry: LedgerEntry): void {
  if (!MOCK_T3N) return;
  const state = getMockState();
  state.entries.push(entry);
  if (entry.status === "paid") state.running_total += entry.amount_usdc;
}
