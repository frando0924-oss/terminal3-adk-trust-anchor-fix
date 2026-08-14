# Terminal 3 ADK onboarding — reproducible compatibility report

## Public deliverables

- Repository: https://github.com/frando0924-oss/terminal3-adk-trust-anchor-fix
- Upstream pull request: https://github.com/Terminal-3/adk-circle-call-centre-agent-demo/pull/1
- Demo repository path: `work/terminal3-adk`
- Visual evidence: `docs/evidence-dashboard-replay.png`

## Terminal 3 onboarding confirmation

The sandbox onboarding was completed through the official Terminal 3 flow. The
generated tenant DID is:

`did:t3n:d28fd75d8ad7fa9fb6322686914f84999c5ed5a`

The sandbox page also issued a one-time API key and test credits. The key is
intentionally not reproduced in this report, repository, screenshots, or
submission text; it remains under the account owner's control.


## What I built

This is a working TypeScript/Rust demo of an AI support agent that can inspect
paid services and request payments through Terminal 3's policy-enforced TEE
boundary. The project includes:

- an OpenAI tool-use agent loop;
- a Rust/WASM policy contract with allowlist, per-call cap, session budget,
  idempotency, revocation, and an append-only audit ledger;
- a payment-relay service with mock mode for safe local reproduction; and
- a dashboard that displays provider comparison, policy state, activity, and
  paid/denied audit entries.

The public replay is explicitly marked as simulated and uses no credentials or
real funds.

## Reproducible bug and fix

With the repository's dependency range (`@terminal3/t3n-sdk: ^4.2.0`), a fresh
install resolves to a newer SDK in which `T3nClientConfig.trustAnchor` is
required. The original constructors supplied only the WASM component and
signing handlers, so a clean TypeScript build failed in the agent, admin
scripts, and dashboard.

The fix resolves the operator-signed manifest with `fetchTrustedManifest`
before each client handshake and passes the resulting trust anchor into every
affected `T3nClient`. Unsafe trust-server behavior remains explicit and is
restricted to sandbox/local development.

The same delivery also adds an explicit payment idempotency key and protects
dashboard mutation routes with a constant-time administrator-token check.

## Verification

All of the following passed locally using mocks/local fixtures only:

```text
agent:          tsc --noEmit -p tsconfig.json
scripts:        tsc --noEmit -p tsconfig.json
payment-relay:  tsc --noEmit -p tsconfig.json
dashboard:      tsc --noEmit -p tsconfig.json
dashboard:      next build
git diff --check
```

The dashboard replay visibly demonstrates three permitted payments and a
fourth attempt denied before payment because it exceeds the per-call cap. No
production API key, wallet private key, recovery phrase, or live payment was
used.
