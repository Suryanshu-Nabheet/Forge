// POST /api/auth/register — create account + session.

import { NextResponse } from "next/server";
import { registerUser, createSession, recordAudit } from "@forge/db";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HANDLE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,38}$/;

export async function POST(req: Request) {
  const body = (await req.json()) as { email?: string; name?: string; handle?: string; password?: string };
  const email = (body.email ?? "").trim().toLowerCase();
  const name = (body.name ?? "").trim();
  const handle = (body.handle ?? "").trim().toLowerCase();
  const password = body.password ?? "";

  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "valid email required" }, { status: 400 });
  if (!HANDLE_RE.test(handle)) return NextResponse.json({ error: "handle: 1-39 chars, letters/digits/-_" }, { status: 400 });
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (password.length < 8) return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });

  try {
    const user = await registerUser(email, name, handle, password);
    const token = await createSession(user.id);
    void recordAudit({ actorId: user.id, actorHandle: user.handle, action: "auth.register", targetType: "account", targetId: user.handle });
    const res = NextResponse.json({ ok: true, user });
    res.cookies.set("forge_session", token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 86400 });
    return res;
  } catch (err) {
    const msg = err instanceof Error && err.message.includes("unique") ? "email or handle already taken" : "registration failed";
    return NextResponse.json({ error: msg }, { status: 409 });
  }
}
