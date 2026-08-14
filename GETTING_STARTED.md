# Getting Started

A from-zero walkthrough for standing up your own instance of this demo. This is the **real
mode** walkthrough — real Terminal 3 account, real Circle wallet, real (small amounts of)
USDC — because that's the only way to actually see the guardrail enforcement (allowlist/cap/
budget checks, live revocation) do something real. If you just want to click around the UI
first with zero accounts, jump to [step 8](#8-run-the-full-mock-demo-works-today-zero-real-infrastructure).

New here? Read [`SECURITY.md`](SECURITY.md) before you go further — it explains exactly which
credentials this demo touches and why the agent itself never holds a payment credential.

## 0. What you'll need

- Node.js ≥ 18, Rust (`rustup`), and the `wasm32-wasip2` target
- A server with a public IP or domain, for the payment relay (a small VPS is enough)
- A Terminal 3 developer account (free — see step 1)
- A Circle account and the `@circle-fin/cli` (free to install; real USDC needed to actually
  pay for anything)
- An OpenAI API key (for the agent's own reasoning loop)
- A Vercel account, if you want to host the dashboard publicly (optional — it runs locally
  too)

## 1. Terminal 3: get a developer key

1. Sign up for a Terminal 3 developer account (see the
   [ADK Quickstart](https://docs.terminal3.io/developers/adk/get-started/quickstart) for the
   current sign-up flow). You'll get a developer key (`T3N_API_KEY`, **usually shown once —
   copy it immediately**) and a tenant DID (`T3N_TENANT_DID`), plus some test tokens.
2. Your demo **agent** is a second, separate identity from your tenant (its own Ethereum
   keypair, its own `AGENT_KEY`) — read the
   [Agent Auth docs](https://docs.terminal3.io/developers/adk/overview/agent-auth-adk) to
   understand how an agent identity gets authorized against your tenant's grant, and check
   the [ADK reference](https://docs.terminal3.io/developers/adk/reference) for the current
   process to give a new agent identity enough credit balance to invoke contract functions.

## 2. Circle: set up the agent wallet

Install and log in (this is interactive — do it in your own terminal, not scripted):

```bash
npm install -g @circle-fin/cli
circle wallet login <your-email> --type agent
```

Follow the prompts (Terms acceptance, then an emailed OTP code). Then:

```bash
circle wallet create --output json          # creates one SCA address across 8 EVM chains
circle wallet list --chain BASE --type agent --output json   # note the address
```

**Fund it.** This scenario's real per-call prices range from a couple of cents for a research
lookup up to ~$0.54 for a real phone call — $10–20 covers a lot of testing. If you don't have
crypto already, Circle's CLI has a built-in fiat on-ramp:

```bash
circle wallet fund --address <your-address> --chain BASE --amount 10 --token usdc --method fiat --open
```

**Most marketplace sellers use Gateway (nanopayments), not vanilla on-chain USDC** — check
with `circle services inspect <url> --output json` before assuming. If a seller's `scheme` is
`GatewayWalletBatched`, deposit into Gateway first (lands on Polygon):

```bash
circle gateway deposit --amount 5 --address <your-address> --chain BASE --method eco
# wait ~30s, then pay with --chain MATIC
```

## 3. Clone and build

```bash
git clone https://github.com/terminal-3/adk-circle-call-centre-agent-demo.git
cd adk-circle-call-centre-agent-demo
npm install
rustup target add wasm32-wasip2
cd contract && cargo build --target wasm32-wasip2 --release && cd ..
```

## 4. Deploy the payment relay

The relay must run on a machine where `circle` is already logged in (Circle's CLI session is
local to the machine, not exportable) — typically the same VPS.

**Give it a public HTTPS endpoint.** The Terminal 3 contract calls this relay from inside its
enclave, so `localhost` won't do, and a bare IP can't get a real TLS certificate. The free
[sslip.io](https://sslip.io) trick works well: a hostname like
`<your-ip-with-dashes>.sslip.io` resolves straight to your IP, which is enough for
[Caddy](https://caddyserver.com) to auto-provision a real certificate:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

sudo tee /etc/caddy/Caddyfile <<'EOF'
<your-ip-with-dashes>.sslip.io {
    reverse_proxy localhost:8787
}
EOF
sudo systemctl reload caddy
```

**Generate the relay's shared secret** (this authenticates the contract's calls to the
relay — it's sealed in Terminal 3 KV, never exposed elsewhere. Never commit this value or
paste it into a shared chat):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Persist your environment** (so you're not re-exporting these on every new shell — keep this
file out of git; `chmod 600` and never commit it):

```bash
cat > ~/.adk-circle-demo.env << 'EOF'
export T3N_API_KEY=<from step 1>
export T3N_TENANT_DID=<from step 1>
export AGENT_KEY=<generate: node -e "console.log('0x'+require('crypto').randomBytes(32).toString('hex'))">
export CIRCLE_WALLET_ADDRESS=<from step 2>
export CIRCLE_DEFAULT_CHAIN=MATIC
export RELAY_SHARED_SECRET=<generated above>
export RELAY_BASE_URL=https://<your-ip-with-dashes>.sslip.io
export PORT=8787
export MOCK_CIRCLE=0
EOF
chmod 600 ~/.adk-circle-demo.env
echo "source ~/.adk-circle-demo.env" >> ~/.bashrc
source ~/.adk-circle-demo.env
```

Start it (use `pm2` or a systemd unit for anything beyond initial testing, so it survives
your SSH session ending):

```bash
npm run start --workspace services/payment-relay
```

Verify: `curl https://<your-domain>/health` should return `{"ok":true,"mock":false}`.

## 5. Provision the Terminal 3 contract

```bash
cd contract && cargo build --target wasm32-wasip2 --release && cd ..
npm run setup --workspace scripts    # registers the contract, creates KV maps, seeds policy+secrets
npm run grant --workspace scripts    # authorizes the demo agent for pay-for-service/get-ledger
```

**Before you run `setup`, open `scripts/setup.ts` and review the `HOST_ALLOWLIST`,
`PER_CALL_CAP_USDC`, and `SESSION_BUDGET_USDC` values** (marked `// CUSTOMIZE:` in the file) —
these are your actual spend policy. The demo defaults are deliberately small and scoped to
the demo's own mock services.

If you re-run `setup` later after changing the contract, bump `CONTRACT_VERSION` first —
Terminal 3 requires a strictly higher version to re-register the same tail.

## 6. Verify the payment path (small, isolated tests before running the full agent)

```bash
# 1. Raw CLI, no relay/Terminal 3 involved:
circle services search "crypto" --output json
circle services inspect "<a resource url>" --output json
circle services pay "<resource url>" -X <method> --address <addr> --chain MATIC --output json

# 2. Through the relay directly (exercises the same code the contract calls):
curl -X POST https://<your-domain>/pay -H "Content-Type: application/json" \
  -H "X-Relay-Secret: $RELAY_SHARED_SECRET" \
  -d '{"service_url":"<url>","method":"GET","payload":{},"idempotency_key":"test-1"}'

# 3. Through Terminal 3 for real (the actual last-mile check):
npm run test-pay --workspace scripts
```

If step 6.3 fails, see [`docs/GOTCHAS.md`](docs/GOTCHAS.md) and the
[ADK common errors doc](https://docs.terminal3.io/developers/adk/tips/common-errors) — most
first-time failures here trace back to a missing `pii_did`, an allowlist mismatch, or an
agent identity that hasn't been granted `pay-for-service` yet.

## 7. Run the dashboard

**Locally:**
```bash
cd dashboard
MOCK_T3N=1 SESSION_BUDGET_USDC=1.0 PER_CALL_CAP_USDC=0.6 RELAY_BASE_URL=https://<your-domain> \
  npm run dev
```
(`MOCK_T3N=1` is a dashboard-only convenience — it renders from an in-memory ledger instead of
a live contract read, so you can see the UI before step 6.3 is fully working. Drop it once
you're ready to read the real ledger, and set `T3N_API_KEY`/`T3N_TENANT_DID`/`AGENT_KEY`
instead.)

Live mode requires an admin session before the browser can poll the ledger or use the mutation
buttons. Set `DASHBOARD_ADMIN_TOKEN` in the server environment, open the dashboard, and use the
live-mode **Sign in to live dashboard** form. The browser sends the token only to the server-side
session route; the response sets an HttpOnly, `SameSite=Strict` cookie. Browser-originated
reset/revoke requests also require same-origin provenance, which prevents a cross-site form from
using that cookie.

**On Vercel:**
1. Import this repo, set **Root Directory** to `dashboard`.
2. Env vars: `T3N_API_KEY`, `T3N_TENANT_DID`, `AGENT_KEY`, `DASHBOARD_ADMIN_TOKEN`,
   `CONTRACT_TAIL=guarded-commerce`.
3. Deploy. If the build fails resolving workspace dependencies, override the install command
   to run from the repo root (`cd .. && npm install`) rather than just `dashboard/`.

## 8. Run the full mock demo (works today, zero real infrastructure)

If you just want to see the whole thing work end to end without any of the above:

```bash
npm install
RELAY_SHARED_SECRET=dev-secret MOCK_CIRCLE=1 PORT=8787 npm run start --workspace services/payment-relay   # terminal 1
cd dashboard && MOCK_T3N=1 SESSION_BUDGET_USDC=1.0 PER_CALL_CAP_USDC=0.6 RELAY_BASE_URL=http://localhost:8787 npm run dev   # terminal 2
```
Open `http://localhost:3000`, then see [`DEMO_SCRIPT.md`](DEMO_SCRIPT.md) for how to drive it.

## 9. Deploy a public replay site to Vercel (optional)

The dashboard also supports a fully static **replay mode** that plays back a fixed, scripted
run entirely in the browser (`dashboard/lib/replay-data.ts` / `useReplay.ts`) — no API calls,
no server-side state, no credentials of any kind. Useful for a public-facing showcase where
you don't want anonymous visitors able to trigger real spend.

1. In Vercel, import this repo (or `vercel` CLI from `dashboard/`).
2. Set **Root Directory** to `dashboard`. Framework (Next.js) is auto-detected.
3. Set exactly one environment variable: `NEXT_PUBLIC_REPLAY_MODE=1`.
4. Deploy. No `T3N_API_KEY`, `AGENT_KEY`, or `RELAY_BASE_URL` needed for this mode — the
   deployed site never calls `/api/ledger`, `/api/events`, `/api/revoke`, or `/api/reset`.

Replace the scripted narrative in `dashboard/lib/replay-data.ts` with your own scenario's
narrative if you use this mode — see [`docs/CUSTOMIZE.md`](docs/CUSTOMIZE.md).

**Hit `Error: No Output Directory named "public" found after the Build completed`?** That
message is Vercel's generic static-site fallback — it appears when the Next.js framework
wasn't detected for the build. In an npm-workspaces monorepo like this one, that usually means
Root Directory / Framework Preset didn't apply before the first build ran. Fix:
1. In the Vercel project's **Settings → General**, confirm **Root Directory** is `dashboard`
   and **Framework Preset** shows **Next.js** — reselect it explicitly if it shows "Other".
2. Trigger a genuinely new deployment (push a commit, or "Redeploy" after confirming the
   corrected settings) rather than retrying the old failed build.
3. `dashboard/vercel.json` pins `"framework": "nextjs"` explicitly as a backstop.

## Troubleshooting

See [`docs/GOTCHAS.md`](docs/GOTCHAS.md) for the concrete bugs/pitfalls hit while building
this demo, and the
[ADK common errors doc](https://docs.terminal3.io/developers/adk/tips/common-errors) for
platform-level errors. If you hit something not covered in either, please open an issue with
the exact command and exact error.
