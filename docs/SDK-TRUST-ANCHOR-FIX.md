# SDK compatibility fix: required trust anchor

## Reproduction

With the dependency range in this repository (`@terminal3/t3n-sdk: ^4.2.0`), a
fresh install resolves to SDK 4.36.0. Type-checking the original code fails in
three places with:

```text
Argument of type '{ wasmComponent; handlers; }' is not assignable to parameter of type 'T3nClientConfig'.
Property 'trustAnchor' is missing in type '{ wasmComponent; handlers; }'.
```

The failure affected the agent client, the administrative scripts helper, and
the dashboard's server-side client. The SDK now requires callers to provide a
client-pinned trust anchor before the handshake.

## Fix

All three client construction paths now fetch the operator-signed manifest with
`fetchTrustedManifest(environment)` and pass the resulting anchor to
`T3nClient`. This preserves attestation verification in normal environments.

For local/mock nodes only, `T3N_UNSAFE_TRUST_SERVER=1` enables the SDK's
explicit unsafe opt-out. It is intentionally opt-in and is never the default.

## Verification

The following checks pass after the fix:

```text
agent:          tsc --noEmit -p tsconfig.json
scripts:        tsc --noEmit -p tsconfig.json
payment-relay:  tsc --noEmit -p tsconfig.json
dashboard:      tsc --noEmit -p tsconfig.json
dashboard:      next build
```

No real credentials, wallets, payments, or production endpoints are required
for these checks.
