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

type Environment = "sandbox" | "testnet" | "production";

const AGENT_KEY = requireEnv("AGENT_KEY");
const TENANT_DID = requireEnv("T3N_TENANT_DID");
const CONTRACT_TAIL = process.env.CONTRACT_TAIL ?? "guarded-commerce";

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

let cachedClient: Promise<T3nClient> | null = null;

async function getClient(): Promise<T3nClient> {
  if (!cachedClient) {
    cachedClient = (async () => {
      const environment = (process.env.T3N_ENVIRONMENT as Environment | undefined) ?? "testnet";
      setEnvironment(environment);
      const wasmComponent = await loadWasmComponent();
      const address = eth_get_address(AGENT_KEY);
      const trustAnchor = await resolveTrustAnchor(environment);
      const client = new T3nClient({
        wasmComponent,
        handlers: { EthSign: metamask_sign(address, undefined, AGENT_KEY) },
        trustAnchor,
      });
      await client.handshake();
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
  relay_ref?: string;
  service_response?: unknown;
  reason?: string;
}

export async function payForService(args: PayForServiceArgs): Promise<PayForServiceResult> {
  const client = await getClient();
  const scriptName = tenantScriptName();
  const scriptVersion = await getScriptVersion(getNodeUrl(), scriptName);
  return client.executeAndDecode<PayForServiceResult>({
    script_name: scriptName,
    script_version: scriptVersion,
    function_name: "pay-for-service",
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
    pii_did: TENANT_DID,
    input: {},
  });
}
