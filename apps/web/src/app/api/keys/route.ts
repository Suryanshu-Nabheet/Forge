// GET/POST /api/keys — SSH key management (session-scoped).

import { NextResponse } from "next/server";
import { listSshKeys, addSshKey } from "@forge/db";
import { requireUser, unauthorized } from "@/server/session";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  const keys = await listSshKeys(user.id);
  return NextResponse.json({ keys });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const body = (await req.json()) as { title?: string; publicKey?: string };
  const key = (body.publicKey ?? "").trim();
  if (!key) return NextResponse.json({ error: "publicKey required" }, { status: 400 });
  if (!/^(ssh-(rsa|ed25519)|ecdsa-[a-z0-9-]+) [A-Za-z0-9+/]+=*( .*)?$/.test(key)) {
    return NextResponse.json({ error: "not a valid SSH public key" }, { status: 400 });
  }
  await addSshKey(user.id, body.title?.trim() || "untitled", key);
  return NextResponse.json({ ok: true });
}
