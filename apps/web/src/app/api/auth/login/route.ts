// POST /api/auth/login — session login; sets forge_session cookie.
// Two-factor flow: when the password verifies and TOTP is enabled, the
// response is { totpRequired: true } WITHOUT a session; the client then
// repeats the request with { code } (or { recoveryCode }) to finish.
// Rate limited: 5 failed attempts per account per minute → 429.
// Keyed by email only — X-Forwarded-For is client-controlled unless a
// trusted proxy overwrites it, and trusting it would let an attacker
// rotate fake IPs to bypass the limit. Deployments behind a proxy that
// sanitizes XFF can extend the key with the real client IP.

import { NextResponse } from "next/server";
import {
  loginUser, createSession, loginBlocked, recordLoginFailure, clearLoginFailures,
  recordAudit, verifyTotp, decryptSecret, consumeRecoveryCode,
} from "@forge/db";
import { eq } from "drizzle-orm";
import { db, users } from "@forge/db";

function clientIp(req: Request): string | null {
  // Socket address is unavailable in route handlers; use the proxy header
  // only as a best-effort annotation for audit (never for authz decisions).
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0]!.trim() : null;
}

export async function POST(req: Request) {
  const body = (await req.json()) as { email?: string; password?: string; code?: string; recoveryCode?: string };
  const email = (body.email ?? "").trim();
  const ip = "login"; // single bucket; see note above

  if (loginBlocked(email, ip)) {
    void recordAudit({ actorId: null, actorHandle: email, action: "auth.login_locked", targetType: "account", targetId: email, ip: clientIp(req) });
    return NextResponse.json(
      { error: "too many attempts — wait a minute and try again" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  // Stage 2: a TOTP code or recovery code was submitted with valid
  // credentials — verify and finish login.
  if (body.code || body.recoveryCode) {
    const user = await loginUser(email, body.password ?? "");
    if (!user) {
      recordLoginFailure(email, ip);
      return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
    }
    const row = (await db
      .select({ totpSecret: users.totpSecret, recoveryCodes: users.recoveryCodes })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1))[0];
    if (!row?.totpSecret) {
      return NextResponse.json({ error: "2FA is not enabled on this account" }, { status: 400 });
    }

    if (body.code) {
      let ok = false;
      try {
        ok = verifyTotp(decryptSecret(row.totpSecret), body.code.trim());
      } catch {
        ok = false; // decryption failure → treat as invalid code
      }
      if (!ok) {
        recordLoginFailure(email, ip);
        void recordAudit({ actorId: user.id, actorHandle: user.handle, action: "auth.totp_failed", targetType: "account", targetId: user.handle, ip: clientIp(req) });
        return NextResponse.json({ error: "invalid code" }, { status: 401 });
      }
    } else if (body.recoveryCode) {
      if (!row.recoveryCodes) {
        return NextResponse.json({ error: "no recovery codes available" }, { status: 400 });
      }
      const remaining = consumeRecoveryCode(row.recoveryCodes, body.recoveryCode);
      if (remaining === null) {
        recordLoginFailure(email, ip);
        void recordAudit({ actorId: user.id, actorHandle: user.handle, action: "auth.recovery_failed", targetType: "account", targetId: user.handle, ip: clientIp(req) });
        return NextResponse.json({ error: "invalid recovery code" }, { status: 401 });
      }
      await db.update(users).set({ recoveryCodes: remaining === "" ? null : remaining }).where(eq(users.id, user.id));
      void recordAudit({ actorId: user.id, actorHandle: user.handle, action: "auth.recovery_used", targetType: "account", targetId: user.handle, ip: clientIp(req) });
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

  // Stage 1: password-only. If 2FA is on, do NOT create a session yet.
  const user = await loginUser(email, body.password ?? "");
  if (!user) {
    recordLoginFailure(email, ip);
    void recordAudit({ actorId: null, actorHandle: email, action: "auth.login_failed", targetType: "account", targetId: email, ip: clientIp(req) });
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }

  const row = (await db
    .select({ totpSecret: users.totpSecret })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1))[0];
  if (row?.totpSecret) {
    // Password verified — challenge for the second factor. Failure counts
    // against the same limiter once stage 2 begins.
    return NextResponse.json({ totpRequired: true });
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
