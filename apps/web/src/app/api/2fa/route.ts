// POST /api/2fa — TOTP enrollment + management (session-scoped).
//   { action: "enroll" }              → generate secret + otpauth URL (unconfirmed)
//   { action: "confirm", code }       → verify code, enable 2FA, return recovery codes (shown once)
//   { action: "disable", code }       → verify a current code, disable 2FA
// GET /api/2fa → { enabled: boolean }

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, users, recordAudit, generateTotpSecret, verifyTotp, generateRecoveryCodes } from "@forge/db";
import { requireUser, unauthorized } from "@/server/session";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  const row = (await db.select({ enabledAt: users.totpEnabledAt }).from(users).where(eq(users.id, user.id)).limit(1))[0];
  return NextResponse.json({ enabled: Boolean(row?.enabledAt) });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => ({}))) as { action?: string; code?: string };

  const action = body.action ?? "";

  if (action === "enroll") {
    const secret = generateTotpSecret();
    const url = `otpauth://totp/Forge:${encodeURIComponent(user.email)}?secret=${secret}&issuer=Forge&algorithm=SHA1&digits=6&period=30`;
    return NextResponse.json({ secret, url });
  }

  if (action === "confirm") {
    const code = (body.code ?? "").trim();
    if (!/^\d{6}$/.test(code)) return NextResponse.json({ error: "6-digit code required" }, { status: 400 });
    // The secret must have been generated in this session step; require the
    // client to echo it back (it was displayed for QR setup) — we never
    // persist unconfirmed secrets.
    const secret = (body as { secret?: string }).secret?.trim() ?? "";
    if (!secret) return NextResponse.json({ error: "secret required" }, { status: 400 });
    if (!verifyTotp(secret, code)) {
      return NextResponse.json({ error: "invalid code — check your authenticator clock" }, { status: 400 });
    }
    const { encryptSecret } = await import("@forge/db");
    const { codes, stored } = generateRecoveryCodes();
    await db.update(users).set({
      totpSecret: encryptSecret(secret),
      totpEnabledAt: new Date(),
      recoveryCodes: stored,
    }).where(eq(users.id, user.id));
    void recordAudit({ actorId: user.id, actorHandle: user.handle, action: "2fa.enable", targetType: "account", targetId: user.handle });
    return NextResponse.json({ ok: true, recoveryCodes: codes });
  }

  if (action === "disable") {
    const code = (body.code ?? "").trim();
    const row = (await db.select({ totpSecret: users.totpSecret }).from(users).where(eq(users.id, user.id)).limit(1))[0];
    if (!row?.totpSecret) return NextResponse.json({ error: "2FA is not enabled" }, { status: 400 });
    const { decryptSecret, verifyTotp: verify } = await import("@forge/db");
    const secret = decryptSecret(row.totpSecret);
    if (!verify(secret, code)) {
      return NextResponse.json({ error: "invalid code" }, { status: 400 });
    }
    await db.update(users).set({ totpSecret: null, totpEnabledAt: null, recoveryCodes: null })
      .where(eq(users.id, user.id));
    void recordAudit({ actorId: user.id, actorHandle: user.handle, action: "2fa.disable", targetType: "account", targetId: user.handle });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
