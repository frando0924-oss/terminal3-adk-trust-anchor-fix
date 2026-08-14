// The dashboard's single page. Renders one of two modes based on the
// NEXT_PUBLIC_REPLAY_MODE env var:
//   - ReplayHome: the public, credential-free build (e.g. deployed on
//     Vercel) that plays back the fixed scripted run from lib/replay-data.ts
//     entirely client-side via lib/useReplay.ts -- no server, no real
//     T3N/Circle credentials involved.
//   - LiveHome: the local/dev build that polls the real backend's
//     /api/ledger and /api/events routes (backed by lib/t3n.ts, which talks
//     to the actual Terminal 3 TEE contract, or an in-memory mock when
//     MOCK_T3N=1).
// Both modes assemble the same panels: BudgetMeter, PolicyPanel,
// ActivityFeed, AuditTrail (and, in replay, AgentChat + ProviderComparison).
"use client";

import { useEffect, useState, useCallback, type FormEvent } from "react";
import { ActivityFeed } from "@/components/ActivityFeed";
import { BudgetMeter } from "@/components/BudgetMeter";
import { PolicyPanel } from "@/components/PolicyPanel";
import { AuditTrail } from "@/components/AuditTrail";
import { ProviderComparison } from "@/components/ProviderComparison";
import { AgentChat } from "@/components/AgentChat";
import { useReplay } from "@/lib/useReplay";
import type { LedgerSnapshot } from "@/lib/t3n";

const POLL_INTERVAL_MS = 2500;
const REPLAY_MODE = process.env.NEXT_PUBLIC_REPLAY_MODE === "1";

export default function Home() {
  if (REPLAY_MODE) return <ReplayHome />;
  return <LiveHome />;
}

// Public deployment default: plays back a fixed, static recorded-shaped run
// entirely in the browser -- no API calls, no server state. This is what
// makes it safe to deploy to Vercel's serverless functions, unlike the live
// mode's in-memory MOCK_T3N ledger (see lib/useReplay.ts / lib/replay-data.ts).
function ReplayHome() {
  const { ledger, events, narration, comparison, started, awaitingRevoke, finished, start, triggerRevoke, restart } = useReplay();

  return (
    <main style={{ maxWidth: 1320, margin: "0 auto", padding: "32px 24px" }}>
      <header style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <div
            style={{
              display: "inline-block",
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--text-muted)",
              border: "1px solid var(--border)",
              borderRadius: 999,
              padding: "4px 10px",
            }}
          >
            Replay of a recorded run — not a live system
          </div>
          <div
            className="mono"
            style={{
              display: "inline-block",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--text-muted)",
              border: "1px solid var(--border)",
              borderRadius: 999,
              padding: "4px 10px",
            }}
          >
            Simulated day: Wed, Jul 8 2026 &middot; 9:00 AM – 10:00 PM UTC
          </div>
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Guarded Agent Commerce</h1>
        <p style={{ color: "var(--text-secondary)", margin: "6px 0 0 0", fontSize: 14 }}>
          An AI agent spending real USDC through Circle&apos;s x402 marketplace -- every payment enforced by a
          Terminal 3 TEE contract the agent cannot bypass.
        </p>
      </header>

      <div className="replay-split">
        <div className="chat-col">
          <AgentChat events={events} started={started} onStart={start} awaitingRevoke={awaitingRevoke} onRevoke={triggerRevoke} />
        </div>

        <div>
          <div
            style={{
              background: "var(--surface-1)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "12px 16px",
              marginBottom: 20,
              fontSize: 14,
              color: "var(--text-secondary)",
            }}
          >
            {!started ? "Send a message in the chat panel to start the agent's day." : finished ? "Replay finished." : narration}
            {awaitingRevoke && (
              <strong style={{ color: "var(--status-critical)" }}>
                {" "}
                — reply in the chat, or click &ldquo;Revoke Agent Access&rdquo; below, to continue.
              </strong>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            <BudgetMeter runningTotal={ledger.running_total} sessionBudget={ledger.session_budget} />
            <PolicyPanel
              perCallCap={ledger.per_call_cap}
              sessionBudget={ledger.session_budget}
              hostAllowlist={ledger.host_allowlist}
              revoked={ledger.revoked}
              replay={{ awaitingRevoke, onRevoke: triggerRevoke, onRestart: restart }}
            />
            {comparison && (
              <div style={{ gridColumn: "1 / -1" }}>
                <ProviderComparison comparison={comparison} />
              </div>
            )}
            <div style={{ gridColumn: "1 / -1", minHeight: 300 }}>
              <ActivityFeed events={events} />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <AuditTrail entries={ledger.entries} />
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

// Local/dev default: polls the real backend (or MOCK_T3N's in-memory ledger)
// over HTTP, exactly as before.
function LiveHome() {
  const [ledger, setLedger] = useState<LedgerSnapshot | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [adminToken, setAdminToken] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [ledgerRes, eventsRes] = await Promise.all([fetch("/api/ledger"), fetch("/api/events")]);
    if (ledgerRes.status === 401 || eventsRes.status === 401) {
      setLedger(null);
      setNeedsAuth(true);
      return;
    }
    if (ledgerRes.ok) setLedger(await ledgerRes.json());
    if (eventsRes.ok) setEvents((await eventsRes.json()).events);
  }, []);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      const response = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: adminToken }),
      });
      if (!response.ok) {
        setAuthError("Invalid administrator token.");
        return;
      }
      setAdminToken("");
      setNeedsAuth(false);
      await refresh();
    } catch {
      setAuthError("Could not reach the dashboard session endpoint.");
    } finally {
      setAuthBusy(false);
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <main style={{ maxWidth: 1200, margin: "0 auto", padding: "32px 24px" }}>
      <header style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Guarded Agent Commerce</h1>
        <p style={{ color: "var(--text-secondary)", margin: "6px 0 0 0", fontSize: 14 }}>
          An AI agent spending real USDC through Circle&apos;s x402 marketplace -- every payment enforced by a
          Terminal 3 TEE contract the agent cannot bypass.
        </p>
      </header>

      {needsAuth ? (
        <form onSubmit={signIn} className="panel" style={{ maxWidth: 520 }}>
          <p className="panel-title">Sign in to live dashboard</p>
          <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
            Enter the administrator token configured on the server. It is sent only to the session endpoint and
            stored by the browser as an HttpOnly cookie.
          </p>
          <label htmlFor="dashboard-admin-token" style={{ display: "block", fontSize: 14, marginBottom: 6 }}>
            Dashboard admin token
          </label>
          <input
            id="dashboard-admin-token"
            type="password"
            autoComplete="current-password"
            value={adminToken}
            onChange={(event) => setAdminToken(event.target.value)}
            required
            style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--page-plane)", color: "var(--text-primary)" }}
          />
          {authError && <p style={{ color: "var(--status-critical)", marginBottom: 0 }}>{authError}</p>}
          <button
            type="submit"
            disabled={authBusy}
            style={{ marginTop: 14, padding: "10px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface-1)", color: "var(--text-primary)", fontWeight: 600 }}
          >
            {authBusy ? "Signing in..." : "Sign in"}
          </button>
        </form>
      ) : !ledger ? (
        <p style={{ color: "var(--text-muted)" }}>Loading ledger...</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          <BudgetMeter runningTotal={ledger.running_total} sessionBudget={ledger.session_budget} />
          <PolicyPanel
            perCallCap={ledger.per_call_cap}
            sessionBudget={ledger.session_budget}
            hostAllowlist={ledger.host_allowlist}
            revoked={ledger.revoked}
            onChanged={refresh}
          />
          <div style={{ gridColumn: "1 / -1", minHeight: 300 }}>
            <ActivityFeed events={events} />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <AuditTrail entries={ledger.entries} />
          </div>
        </div>
      )}
    </main>
  );
}
