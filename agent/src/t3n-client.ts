// WHAT THIS FILE DOES (READ ME FIRST -- this is the key teaching file in
// this template): this is the ONLY place in the agent that talks to
// Terminal 3's ADK (@terminal3/t3n-sdk). It shows the full connect-and-auth
// flow (setEnvironment -> loadWasmComponent -> eth_get_address -> construct
// T3nClient -> handshake -> authenticate) once, cached, and then exposes two
// thin wrapper functions (payForService, getLedger) that call into a
// Terminal 3 TEE contract via client.executeAndDecode(). If you're wiring
// your own agent up to Terminal 3, this is the file to copy the pattern
// from -- see the inline comments on each step below.
//
// The agent's ONLY connection to Terminal 3. This process authenticates as
// itself (AGENT_KEY -> its own DID) and never holds Circle credentials --
// those live sealed in the contract's `secrets` KV map, read only inside the
// enclave. This file has no MOCK_CIRCLE / mock branch: Terminal 3 calls are
// always real once AGENT_KEY + T3N_TENANT_DID are set, regardless of whether
// Circle itself is mocked -- mocking happens one hop further down, inside
// services/payment-relay, not here.
import {
  T3nClient,
  setEnvironment,
  loadWasmComponent,
  eth_get_address,
  metamask_sign,
  createEthAuthInput,
  fetchTrustedManifest,
  getScriptVersion,
  getNodeUrl,
} from "@terminal3/t3n-sdk";

const AGENT_KEY = requireEnv("AGENT_KEY");
const TENANT_DID = requireEnv("T3N_TENANT_DID");
const CONTRACT_TAIL = process.env.CONTRACT_TAIL ?? "guarded-commerce";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see docs/DEVELOPER_BUILD_LOG.md §4)`);
  return value;
}

let cachedClient: Promise<T3nClient> | null = null;

async function getClient(): Promise<T3nClient> {
  if (!cachedClient) {
    cachedClient = (async () => {
      // Step 1: setEnvironment() -- tell the SDK which Terminal 3 network to
      // talk to (sandbox / testnet / production). This must happen before
      // any other SDK call; it controls which node URL / contract registry
      // the rest of this function resolves against.
      const environment = (process.env.T3N_ENVIRONMENT as "sandbox" | "testnet" | "production") ?? "testnet";
      setEnvironment(environment);
      // Step 2: loadWasmComponent() -- loads the SDK's WASM component that
      // does the actual protocol/crypto work (handshake, request signing,
      // encoding). The T3nClient below is a thin JS wrapper around this.
      const wasmComponent = await loadWasmComponent();
      // Step 3: eth_get_address() -- derives this agent's Ethereum-style
      // address from its private key (AGENT_KEY). This address is the
      // agent's own on-chain identity -- separate from TENANT_DID, which is
      // whose *data/grant* the agent is allowed to act on behalf of (see
      // pii_did below).
      const address = eth_get_address(AGENT_KEY);
      // SDK 4.36+ requires an explicit trust anchor before the handshake.
      // Fetch the operator-signed anchor by default. The unsafe opt-out is
      // intentionally explicit and is only suitable for local/mock nodes.
      const trustAnchor = process.env.T3N_UNSAFE_TRUST_SERVER === "1"
        ? { unsafe_trust_server: true as const }
        : await fetchTrustedManifest(environment);
      // Step 4: construct T3nClient, wiring up an EthSign handler
      // (metamask_sign) so the client can sign the handshake/auth
      // challenges with AGENT_KEY without this code needing to touch
      // signature bytes directly.
      const client = new T3nClient({
        wasmComponent,
        handlers: { EthSign: metamask_sign(address, undefined, AGENT_KEY) },
        trustAnchor,
      });
      // Step 5: client.handshake() -- establishes the initial secure session
      // with the Terminal 3 node (key exchange), before any authenticated
      // call can be made.
      await client.handshake();
      // Step 6: client.authenticate() -- proves control of `address` (via
      // the EthSign handler wired in above) so the node knows which agent
      // identity is issuing calls on this client instance.
      await client.authenticate(createEthAuthInput(address));
      return client;
    })();
  }
  return cachedClient;
}

function tenantScriptName(): string {
  const tid = TENANT_DID.slice("did:t3n:".length);
  return `z:${tid}:${CONTRACT_TAIL}`;
}

export interface PayForServiceArgs {
  service_url: string;
  method: string;
  amount_usdc: number;
  payload: unknown;
  idempotency_key: string;
}

export interface PayForServiceResult {
  authorized: boolean;
  remaining_budget: number;
  // Present only when authorized is true (a real payment settled). A denial
  // (policy_denied/relay_failed) returns authorized:false + reason instead of
  // throwing -- see contract/src/pay.rs's module doc for why: returning Err
  // for a denial used to roll back that attempt's own ledger entry.
  relay_ref?: string;
  service_response?: unknown;
  reason?: string;
}

export async function payForService(args: PayForServiceArgs): Promise<PayForServiceResult> {
  const client = await getClient();
  const scriptName = tenantScriptName();
  const scriptVersion = await getScriptVersion(getNodeUrl(), scriptName);
  // client.executeAndDecode() is the actual call into the Terminal 3 TEE
  // contract. The call shape:
  //   - function_name: which contract function to invoke ("pay-for-service"
  //     here) -- this is what actually spends money, enforced inside the
  //     enclave, not by this client code.
  //   - pii_did: whose grant/permissions get checked for this call -- see
  //     the note below, this is not automatically the agent's own identity.
  //   - input: the function's arguments (PayForServiceArgs here), passed
  //     through to the contract as-is.
  return client.executeAndDecode<PayForServiceResult>({
    script_name: scriptName,
    script_version: scriptVersion,
    function_name: "pay-for-service",
    // pii_did tells the contract WHOSE grant to check for this call -- it is
    // NOT automatically the agent's own identity, and that distinction
    // matters a lot: this is a delegated call (the agent is acting on
    // behalf of a tenant), so pii_did must be set to the tenant's DID, not
    // left to default.
    //
    // Delegated call: without pii_did this defaults to the agent's OWN did,
    // so the node looks up AGENT_AUTH_MAP[agent_did] (empty) instead of
    // AGENT_AUTH_MAP[tenant_did] (where the real grant lives) -- surfaces as
    // host/http.egress_denied with allowed=None, not an auth/permission
    // error, because the lookup itself "succeeds" against the wrong subject.
    // Root-caused with Terminal 3's backend team -- see
    // docs/DEVELOPER_BUILD_LOG.md §3o.
    pii_did: TENANT_DID,
    input: args,
  });
}

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
  // Count of stored entries the contract found but couldn't parse -- see
  // ledger.rs's read_all_entries(). 0 in normal operation; a non-zero value
  // means something wrote a malformed entry, worth investigating even
  // though it no longer breaks reading the rest of the ledger.
  malformed_entries: number;
}

export async function getLedger(): Promise<LedgerSnapshot> {
  const client = await getClient();
  const scriptName = tenantScriptName();
  const scriptVersion = await getScriptVersion(getNodeUrl(), scriptName);
  return client.executeAndDecode<LedgerSnapshot>({
    script_name: scriptName,
    script_version: scriptVersion,
    function_name: "get-ledger",
    // Same reasoning as payForService's pii_did -- this is the tenant's
    // ledger, not the agent's own; set explicitly rather than relying on
    // a default that happened not to matter for this read-only call.
    pii_did: TENANT_DID,
    input: {},
  });
}
// WHAT THIS FILE DOES (READ ME FIRST -- this is the key teaching file in
// this template): this is the ONLY place in the agent that talks to
// Terminal 3's ADK (@terminal3/t3n-sdk). It shows the full connect-and-auth
// flow (setEnvironment -> loadWasmComponent -> eth_get_address -> construct
// T3nClient -> handshake -> authenticate) once, cached, and then exposes two
// thin wrapper functions (payForService, getLedger) that call into a
// Terminal 3 TEE contract via client.executeAndDecode(). If you're wiring
// your own agent up to Terminal 3, this is the file to copy the pattern
// from -- see the inline comments on each step below.
//
// The agent's ONLY connection to Terminal 3. This process authenticates as
// itself (AGENT_KEY -> its own DID) and never holds Circle credentials --
// those live sealed in the contract's `secrets` KV map, read only inside the
// enclave. This file has no MOCK_CIRCLE / mock branch: Terminal 3 calls are
// always real once AGENT_KEY + T3N_TENANT_DID are set, regardless of whether
// Circle itself is mocked -- mocking happens one hop further down, inside
// services/payment-relay, not here.
import {
  T3nClient,
  setEnvironment,
  loadWasmComponent,
  eth_get_address,
  metamask_sign,
  createEthAuthInput,
  getScriptVersion,
  getNodeUrl,
} from "@terminal3/t3n-sdk";

const AGENT_KEY = requireEnv("AGENT_KEY");
const TENANT_DID = requireEnv("T3N_TENANT_DID");
const CONTRACT_TAIL = process.env.CONTRACT_TAIL ?? "guarded-commerce";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see docs/DEVELOPER_BUILD_LOG.md §4)`);
  return value;
}

let cachedClient: Promise<T3nClient> | null = null;

async function getClient(): Promise<T3nClient> {
  if (!cachedClient) {
    cachedClient = (async () => {
      // Step 1: setEnvironment() -- tell the SDK which Terminal 3 network to
      // talk to (sandbox / testnet / production). This must happen before
      // any other SDK call; it controls which node URL / contract registry
      // the rest of this function resolves against.
      setEnvironment((process.env.T3N_ENVIRONMENT as "sandbox" | "testnet" | "production") ?? "testnet");
      // Step 2: loadWasmComponent() -- loads the SDK's WASM component that
      // does the actual protocol/crypto work (handshake, request signing,
      // encoding). The T3nClient below is a thin JS wrapper around this.
      const wasmComponent = await loadWasmComponent();
      // Step 3: eth_get_address() -- derives this agent's Ethereum-style
      // address from its private key (AGENT_KEY). This address is the
      // agent's own on-chain identity -- separate from TENANT_DID, which is
      // whose *data/grant* the agent is allowed to act on behalf of (see
      // pii_did below).
      const address = eth_get_address(AGENT_KEY);
      // Step 4: construct T3nClient, wiring up an EthSign handler
      // (metamask_sign) so the client can sign the handshake/auth
      // challenges with AGENT_KEY without this code needing to touch
      // signature bytes directly.
      const client = new T3nClient({
        wasmComponent,
        handlers: { EthSign: metamask_sign(address, undefined, AGENT_KEY) },
      });
      // Step 5: client.handshake() -- establishes the initial secure session
      // with the Terminal 3 node (key exchange), before any authenticated
      // call can be made.
      await client.handshake();
      // Step 6: client.authenticate() -- proves control of `address` (via
      // the EthSign handler wired in above) so the node knows which agent
      // identity is issuing calls on this client instance.
      await client.authenticate(createEthAuthInput(address));
      return client;
    })();
  }
  return cachedClient;
}

function tenantScriptName(): string {
  const tid = TENANT_DID.slice("did:t3n:".length);
  return `z:${tid}:${CONTRACT_TAIL}`;
}

export interface PayForServiceArgs {
  service_url: string;
  method: string;
  amount_usdc: number;
  payload: unknown;
  idempotency_key: string;
}

export interface PayForServiceResult {
  authorized: boolean;
  remaining_budget: number;
  // Present only when authorized is true (a real payment settled). A denial
  // (policy_denied/relay_failed) returns authorized:false + reason instead of
  // throwing -- see contract/src/pay.rs's module doc for why: returning Err
  // for a denial used to roll back that attempt's own ledger entry.
  relay_ref?: string;
  service_response?: unknown;
  reason?: string;
}

export async function payForService(args: PayForServiceArgs): Promise<PayForServiceResult> {
  const client = await getClient();
  const scriptName = tenantScriptName();
  const scriptVersion = await getScriptVersion(getNodeUrl(), scriptName);
  // client.executeAndDecode() is the actual call into the Terminal 3 TEE
  // contract. The call shape:
  //   - function_name: which contract function to invoke ("pay-for-service"
  //     here) -- this is what actually spends money, enforced inside the
  //     enclave, not by this client code.
  //   - pii_did: whose grant/permissions get checked for this call -- see
  //     the note below, this is not automatically the agent's own identity.
  //   - input: the function's arguments (PayForServiceArgs here), passed
  //     through to the contract as-is.
  return client.executeAndDecode<PayForServiceResult>({
    script_name: scriptName,
    script_version: scriptVersion,
    function_name: "pay-for-service",
    // pii_did tells the contract WHOSE grant to check for this call -- it is
    // NOT automatically the agent's own identity, and that distinction
    // matters a lot: this is a delegated call (the agent is acting on
    // behalf of a tenant), so pii_did must be set to the tenant's DID, not
    // left to default.
    //
    // Delegated call: without pii_did this defaults to the agent's OWN did,
    // so the node looks up AGENT_AUTH_MAP[agent_did] (empty) instead of
    // AGENT_AUTH_MAP[tenant_did] (where the real grant lives) -- surfaces as
    // host/http.egress_denied with allowed=None, not an auth/permission
    // error, because the lookup itself "succeeds" against the wrong subject.
    // Root-caused with Terminal 3's backend team -- see
    // docs/DEVELOPER_BUILD_LOG.md §3o.
    pii_did: TENANT_DID,
    input: args,
  });
}

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
  // Count of stored entries the contract found but couldn't parse -- see
  // ledger.rs's read_all_entries(). 0 in normal operation; a non-zero value
  // means something wrote a malformed entry, worth investigating even
  // though it no longer breaks reading the rest of the ledger.
  malformed_entries: number;
}

export async function getLedger(): Promise<LedgerSnapshot> {
  const client = await getClient();
  const scriptName = tenantScriptName();
  const scriptVersion = await getScriptVersion(getNodeUrl(), scriptName);
  return client.executeAndDecode<LedgerSnapshot>({
    script_name: scriptName,
    script_version: scriptVersion,
    function_name: "get-ledger",
    // Same reasoning as payForService's pii_did -- this is the tenant's
    // ledger, not the agent's own; set explicitly rather than relying on
    // a default that happened not to matter for this read-only call.
    pii_did: TENANT_DID,
    input: {},
  });
}
