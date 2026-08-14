// WHAT THIS FILE DOES: Exposes pay_for_service (loop.ts) -- the ONLY tool in
// this agent that can spend money. It's a thin wrapper: it generates an
// the caller-supplied stable idempotency key and delegates to t3n-client.ts's payForService(), which is
// what actually calls into the Terminal 3 TEE contract. See t3n-client.ts
// for how that connection and the pii_did-gated authorization work.
//
// The ONLY tool that can move money. Everything else in the agent's tool
// list is read-only discovery. Routes through Terminal 3 -- this process
// never sees a Circle credential.
import { payForService as t3nPayForService, type PayForServiceResult } from "../t3n-client.js";

export async function payForService(args: {
  service_url: string;
  method: string;
  amount_usdc: number;
  payload?: unknown;
  idempotency_key: string;
}): Promise<PayForServiceResult | { authorized: false; error: string }> {
  try {
    return await t3nPayForService({
      service_url: args.service_url,
      method: args.method,
      amount_usdc: args.amount_usdc,
      payload: args.payload ?? {},
      idempotency_key: args.idempotency_key,
    });
  } catch (err) {
    // policy_denied and relay_failed resolve normally now (authorized:false +
    // reason -- see contract/src/pay.rs's module doc), so their ledger entry
    // commits. Only genuine faults land here: host/http.egress_denied,
    // InsufficientCreditError, KV read/write errors, etc. -- surfaced to the
    // model as a normal tool result, not a crash, so it can reason about it
    // (or the dashboard can render it) rather than the loop dying.
    return { authorized: false, error: err instanceof Error ? err.message : String(err) };
  }
}
