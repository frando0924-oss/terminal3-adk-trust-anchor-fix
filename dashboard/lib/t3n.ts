// SERVER-ONLY. Never import this module from a client component.
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

type Environment = "sandbox" | "testnet" | "production";
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
  malformed_entries?: number;
}

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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see docs/DEVELOPER_BUILD_LOG.md §4)`);
  return value;
}

async function resolveTrustAnchor(environment: Environment) {
  if (process.env.T3N_UNSAFE_TRUST_SERVER === "1") {
    const localOnly = process.env.NODE_ENV !== "production" && environment === "sandbox" && process.env.T3N_LOCAL_DEV === "1";
    if (!localOnly) throw new Error("T3N_UNSAFE_TRUST_SERVER=1 is only allowed for explicit local sandbox development");
    return { unsafe_trust_server: true as const };
  }
  return fetchTrustedManifest(environment);
}

let cachedTenant: Promise<{ t3n: T3nClient; tenant: TenantClient; tenantDid: string }> | null = null;

async function getTenant() {
  if (!cachedTenant) {
    cachedTenant = (async () => {
      const T3N_API_KEY = requireEnv("T3N_API_KEY");
      const environment = (process.env.T3N_ENVIRONMENT as Environment | undefined) ?? "testnet";
      setEnvironment(environment);
      const wasmComponent = await loadWasmComponent();
      const address = eth_get_address(T3N_API_KEY);
      const trustAnchor = await resolveTrustAnchor(environment);
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

export async function readLedger(): Promise<LedgerSnapshot> {
  if (MOCK_T3N) return getMockState();
  const { t3n, tenantDid } = await getTenant();
  const scriptName = tenantScriptName(tenantDid);
  const scriptVersion = await getScriptVersion(getNodeUrl(), scriptName);
  return t3n.executeAndDecode<LedgerSnapshot>({
    script_name: scriptName,
    script_version: scriptVersion,
    function_name: "get-ledger",
    pii_did: tenantDid,
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
  const environment = (process.env.T3N_ENVIRONMENT as Environment | undefined) ?? "testnet";
  setEnvironment(environment);
  const wasmComponent = await loadWasmComponent();
  const agentAddress = eth_get_address(AGENT_KEY);
  const trustAnchor = await resolveTrustAnchor(environment);
  const agentT3n = new T3nClient({
    wasmComponent,
    handlers: { EthSign: metamask_sign(agentAddress, undefined, AGENT_KEY) },
    trustAnchor,
  });
  await agentT3n.handshake();
  const agentDid = (await agentT3n.authenticate(createEthAuthInput(agentAddress))).value;
  const { t3n, tenantDid } = await getTenant();
  await t3n.updateAgentAuth(agentDid, {
    scriptName: tenantScriptName(tenantDid),
    versionReq: null,
    functions: ["pay-for-service", "get-ledger"],
    allowedHosts: [],
  });
}

export function mockAppendEntry(entry: LedgerEntry): void {
  if (!MOCK_T3N) return;
  const state = getMockState();
  state.entries.push(entry);
  if (entry.status === "paid") state.running_total += entry.amount_usdc;
}
