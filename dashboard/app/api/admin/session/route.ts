// Establishes the live dashboard session without exposing DASHBOARD_ADMIN_TOKEN
// to client JavaScript. The operator submits the token to this server route;
// the browser receives only an HttpOnly, SameSite-strict session cookie.
import { NextRequest, NextResponse } from "next/server";
import { isAdminToken } from "@/lib/admin-auth";

export async function POST(request: NextRequest) {
  let token: unknown;
  try {
    token = (await request.json()).token;
  } catch {
    return NextResponse.json({ error: "Expected JSON with a token" }, { status: 400 });
  }

  if (typeof token !== "string" || !isAdminToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const response = NextResponse.json({ authenticated: true });
  response.cookies.set("dashboard_admin_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
  });
  return response;
}
