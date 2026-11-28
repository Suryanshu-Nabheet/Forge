// POST /api/auth/login — session login; sets forge_session cookie.
// Rate limited: 5 failed attempts per account per minute → 429.
// Keyed by email only — X-Forwarded-For is client-controlled unless a
// trusted proxy overwrites it, and trusting it would let an attacker
// rotate fake IPs to bypass the limit. Deployments behind a proxy that
// sanitizes XFF can extend the key with the real client IP.

import { NextResponse } from "next/server";
import { loginUser, createSession, loginBlocked, recordLoginFailure, clearLoginFailures, recordAudit } from "@forge/db";

function clientIp(req: Request): string | null {
  // Socket address is unavailable in route handlers; use the proxy header
  // only as a best-effort annotation for audit (never for authz decisions).
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0]!.trim() : null;
}

export async function POST(req: Request) {
  const body = (await req.json()) as { email?: string; password?: string };
  const email = (body.email ?? "").trim();
  const ip = "login"; // single bucket; see note above

  if (loginBlocked(email, ip)) {
    void recordAudit({ actorId: null, actorHandle: email, action: "auth.login_locked", targetType: "account", targetId: email, ip: clientIp(req) });
    return NextResponse.json(
      { error: "too many attempts — wait a minute and try again" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const user = await loginUser(email, body.password ?? "");
  if (!user) {
    recordLoginFailure(email, ip);
    void recordAudit({ actorId: null, actorHandle: email, action: "auth.login_failed", targetType: "account", targetId: email, ip: clientIp(req) });
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }
  clearLoginFailures(email, ip);
  void recordAudit({ actorId: user.id, actorHandle: user.handle, action: "auth.login", targetType: "account", targetId: user.handle, ip: clientIp(req) });

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
