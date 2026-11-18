// POST /api/auth/login — session login; sets forge_session cookie.
// Rate limited: 5 failed attempts per email+IP per minute → 429.

import { NextResponse } from "next/server";
import { loginUser, createSession, loginBlocked, recordLoginFailure, clearLoginFailures } from "@forge/db";

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return "local";
}

export async function POST(req: Request) {
  const body = (await req.json()) as { email?: string; password?: string };
  const email = (body.email ?? "").trim();
  const ip = clientIp(req);

  if (loginBlocked(email, ip)) {
    return NextResponse.json(
      { error: "too many attempts — wait a minute and try again" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const user = await loginUser(email, body.password ?? "");
  if (!user) {
    recordLoginFailure(email, ip);
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }
  clearLoginFailures(email, ip);

  const token = await createSession(user.id);
  const res = NextResponse.json({ ok: true, user });
  res.cookies.set("forge_session", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 86400,
  });
  return res;
}
