// Live-mode API route behind the dashboard's "Reset Budget" button. Calls
// lib/t3n.ts's resetBudget(), which zeroes the session's running_total on
// the contract (or in-memory mock) so a demo can be re-run without waiting
// for a new session. It does not touch the audit-trail entries themselves.
import { NextRequest, NextResponse } from "next/server";
import { resetBudget } from "@/lib/t3n";
import { isAdminRequest } from "@/lib/admin-auth";

// Between-takes convenience for rehearsal -- resets the session budget only.
// Ledger entries are never cleared; see scripts/reset-budget.ts for why.
export async function POST(request: NextRequest) {
  if (!isAdminRequest(request, { mutating: true })) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await resetBudget();
    return NextResponse.json({ reset: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
