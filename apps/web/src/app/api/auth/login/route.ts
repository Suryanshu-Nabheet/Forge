// POST /api/auth/login — session login; sets forge_session cookie.

import { NextResponse } from "next/server";
import { loginUser, createSession } from "@forge/db";

export async function POST(req: Request) {
  const body = (await req.json()) as { email?: string; password?: string };
  const user = await loginUser((body.email ?? "").trim(), body.password ?? "");
  if (!user) return NextResponse.json({ error: "invalid credentials" }, { status: 401 });

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
