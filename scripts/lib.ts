// WHAT: Shared helper used by every other script in this folder -- it's the
// one place that knows how to authenticate an Ethereum keypair against
// Terminal 3 and get back a usable client + DID. You won't run this file
// directly; it's imported by the others.
// WHEN: N/A -- not run standalone. Read it if you want to understand how
// auth works across all the scripts, or if you're adding a new script.
//
// Shared auth helper for the admin scripts. Every T3N identity (tenant or
// agent) authenticates the same way -- an Ethereum keypair signs a login
// challenge and the session hands back the DID that authenticator resolves
// to. Golden rule (Terminal 3's own docs): never hardcode/derive a DID --
// always read it back from the authenticated session.
import {
  T3nClient,
  setEnvironment,
  loadWasmComponent,
  eth_get_address,
  metamask_sign,
  createEthAuthInput,
  fetchTrustedManifest,
} from "@terminal3/t3n-sdk";

export async function authenticate(privateKey: string): Promise<{ t3n: T3nClient; address: string; did: string }> {
  const environment = (process.env.T3N_ENVIRONMENT as "sandbox" | "testnet" | "production") ?? "testnet";
  setEnvironment(environment);

  const wasmComponent = await loadWasmComponent();
  const address = eth_get_address(privateKey);
  const trustAnchor = process.env.T3N_UNSAFE_TRUST_SERVER === "1"
    ? { unsafe_trust_server: true as const }
    : await fetchTrustedManifest(environment);

  const t3n = new T3nClient({
    wasmComponent,
    handlers: {
      EthSign: metamask_sign(address, undefined, privateKey),
    },
    trustAnchor,
  });

  await t3n.handshake();
  const didResult = await t3n.authenticate(createEthAuthInput(address));
  return { t3n, address, did: didResult.value };
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see docs/DEVELOPER_BUILD_LOG.md §4)`);
  return value;
}

export const CONTRACT_TAIL = process.env.CONTRACT_TAIL ?? "guarded-commerce";
// WHAT: Shared helper used by every other script in this folder -- it's the
// one place that knows how to authenticate an Ethereum keypair against
// Terminal 3 and get back a usable client + DID. You won't run this file
// directly; it's imported by the others.
// WHEN: N/A -- not run standalone. Read it if you want to understand how
// auth works across all the scripts, or if you're adding a new script.
//
// Shared auth helper for the admin scripts. Every T3N identity (tenant or
// agent) authenticates the same way -- an Ethereum keypair signs a login
// challenge and the session hands back the DID that authenticator resolves
// to. Golden rule (Terminal 3's own docs): never hardcode/derive a DID --
// always read it back from the authenticated session.
import {
  T3nClient,
  setEnvironment,
  loadWasmComponent,
  eth_get_address,
  metamask_sign,
  createEthAuthInput,
} from "@terminal3/t3n-sdk";

export async function authenticate(privateKey: string): Promise<{ t3n: T3nClient; address: string; did: string }> {
  setEnvironment((process.env.T3N_ENVIRONMENT as "sandbox" | "testnet" | "production") ?? "testnet");

  const wasmComponent = await loadWasmComponent();
  const address = eth_get_address(privateKey);

  const t3n = new T3nClient({
    wasmComponent,
    handlers: {
      EthSign: metamask_sign(address, undefined, privateKey),
    },
  });

  await t3n.handshake();
  const didResult = await t3n.authenticate(createEthAuthInput(address));
  return { t3n, address, did: didResult.value };
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see docs/DEVELOPER_BUILD_LOG.md §4)`);
  return value;
}

export const CONTRACT_TAIL = process.env.CONTRACT_TAIL ?? "guarded-commerce";
