import {
  T3nClient,
  setEnvironment,
  loadWasmComponent,
  eth_get_address,
  metamask_sign,
  createEthAuthInput,
  fetchTrustedManifest,
} from "@terminal3/t3n-sdk";

const apiKey = process.env.T3N_API_KEY;
if (!apiKey) {
  throw new Error("T3N_API_KEY is required; provide it only through the local environment.");
}

setEnvironment("testnet");
const wasmComponent = await loadWasmComponent();
const address = eth_get_address(apiKey);
const trustAnchor = await fetchTrustedManifest("testnet");
const t3n = new T3nClient({
  wasmComponent,
  handlers: { EthSign: metamask_sign(address, undefined, apiKey) },
  trustAnchor,
});

await t3n.handshake();
const did = await t3n.authenticate(createEthAuthInput(address));
console.log("Connected as:", did.value);

const usage = await t3n.getUsage();
console.log("Usage:", JSON.stringify(usage));
