import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

function sameSecret(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

export function isAdminToken(supplied: string | undefined): boolean {
  const expected = process.env.DASHBOARD_ADMIN_TOKEN;
  return Boolean(expected && supplied && sameSecret(expected, supplied));
}

function isSameOriginRequest(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (origin) return origin === request.nextUrl.origin;

  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}

export function isAdminRequest(request: NextRequest, options: { mutating?: boolean } = {}): boolean {
  const bearer = request.headers.get("authorization");
  const headerToken = bearer?.startsWith("Bearer ")
    ? bearer.slice("Bearer ".length)
    : request.headers.get("x-dashboard-admin-token");
  if (headerToken) return isAdminToken(headerToken);

  const cookieToken = request.cookies.get("dashboard_admin_token")?.value;
  if (!cookieToken || (options.mutating && !isSameOriginRequest(request))) return false;
  return isAdminToken(cookieToken);
}
