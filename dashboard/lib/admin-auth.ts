import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

function sameSecret(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

export function isAdminRequest(request: NextRequest): boolean {
  const expected = process.env.DASHBOARD_ADMIN_TOKEN;
  if (!expected) return false;
  const bearer = request.headers.get("authorization");
  const supplied = bearer?.startsWith("Bearer ")
    ? bearer.slice("Bearer ".length)
    : request.headers.get("x-dashboard-admin-token") ?? request.cookies.get("dashboard_admin_token")?.value;
  return supplied ? sameSecret(expected, supplied) : false;
}
