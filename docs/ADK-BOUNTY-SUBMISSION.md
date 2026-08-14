# Terminal 3 ADK onboarding and SDK compatibility report

## Scope

This report documents a reproducible compatibility failure encountered while
building the repository against the published `@terminal3/t3n-sdk` package, and
the corresponding fix in this pull request:

<https://github.com/Terminal-3/adk-circle-call-centre-agent-demo/pull/1>

The report intentionally contains no API keys, wallet private keys, recovery
phrases, or production credentials.

## Reproduction

With the repository's dependency range (`@terminal3/t3n-sdk: ^4.2.0`), a fresh
install resolves to SDK `4.36.0`. Type-checking the original code fails because
the SDK requires `T3nClientConfig.trustAnchor`, while the original client
constructors supplied only the WASM component and signing handlers.

The affected construction paths were:

- `agent/src/t3n-client.ts`
- `scripts/lib.ts`
- `dashboard/lib/t3n.ts`

The failure prevents a clean TypeScript build of the agent, administrative
scripts, and dashboard.

## Fix delivered

The pull request now:

1. Resolves the operator-signed manifest with
   `fetchTrustedManifest(environment)` before each client handshake.
2. Passes the resulting trust anchor into every affected `T3nClient`.
3. Keeps the unsafe trust-server option explicit and rejects it in production;
   it is limited to sandbox/local development.
4. Adds an explicit idempotency key to the payment path.
5. Protects the dashboard ledger/reset/revoke routes with a constant-time
   administrator-token check.

The detailed implementation note is available at
[`SDK-TRUST-ANCHOR-FIX.md`](SDK-TRUST-ANCHOR-FIX.md).

## Verification

The following checks passed locally after the fix:

```text
agent:          tsc --noEmit -p tsconfig.json
scripts:        tsc --noEmit -p tsconfig.json
payment-relay:  tsc --noEmit -p tsconfig.json
dashboard:      tsc --noEmit -p tsconfig.json
dashboard:      next build
git diff --check
```

The build and tests use mocks/local fixtures only. No production payment,
wallet, or credential was used.

## Reproduction guidance for reviewers

1. Clone the pull-request branch.
2. Install dependencies with the repository's documented package-manager flow.
3. Run the package type-check commands listed above.
4. Confirm that the client constructors receive a resolved trust anchor in
   normal environments.
5. Confirm that the unsafe option cannot be enabled by a production process and
   that dashboard mutation routes reject requests without the admin token.

