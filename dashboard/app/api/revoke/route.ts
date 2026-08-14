// Live-mode API route behind the dashboard's "Revoke Agent Access" button --
// the demo's signature moment. Calls lib/t3n.ts's revokeAgent(), which runs
// server-side only (the tenant/agent keys never reach the browser) and
// clears the agent's allowedHosts grant on the TEE contract. See the
// comment on revokeAgent() in lib/t3n.ts for exactly what this does and
// does not do.
import { NextRequest, NextResponse } from "next/server";
import { revokeAgent } from "@/lib/t3n";
import { isAdminRequest } from "@/lib/admin-auth";

// The live "wow moment" button. Credentials never touch the browser -- this
// route runs the agent-auth-update grant-clearing call server-side.
export async function POST(request: NextRequest) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await revokeAgent();
    return NextResponse.json({ revoked: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
