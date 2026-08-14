import {
  T3nClient,
  setEnvironment,
  loadWasmComponent,
  eth_get_address,
  metamask_sign,
  createEthAuthInput,
  fetchTrustedManifest,
} from "@terminal3/t3n-sdk";

type Environment = "sandbox" | "testnet" | "production";

export async function authenticate(privateKey: string): Promise<{ t3n: T3nClient; address: string; did: string }> {
  const environment = (process.env.T3N_ENVIRONMENT as Environment | undefined) ?? "testnet";
  setEnvironment(environment);
  const wasmComponent = await loadWasmComponent();
  const address = eth_get_address(privateKey);
  const trustAnchor = process.env.T3N_UNSAFE_TRUST_SERVER === "1"
    ? await resolveLocalTrustAnchor(environment)
    : await fetchTrustedManifest(environment);
  const t3n = new T3nClient({
    wasmComponent,
    handlers: { EthSign: metamask_sign(address, undefined, privateKey) },
    trustAnchor,
  });
  await t3n.handshake();
  const didResult = await t3n.authenticate(createEthAuthInput(address));
  return { t3n, address, did: didResult.value };
}

async function resolveLocalTrustAnchor(environment: Environment) {
  const localOnly = process.env.NODE_ENV !== "production" && environment === "sandbox" && process.env.T3N_LOCAL_DEV === "1";
  if (!localOnly) throw new Error("T3N_UNSAFE_TRUST_SERVER=1 is only allowed for explicit local sandbox development");
  return { unsafe_trust_server: true as const };
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see docs/DEVELOPER_BUILD_LOG.md §4)`);
  return value;
}

export const CONTRACT_TAIL = process.env.CONTRACT_TAIL ?? "guarded-commerce";
