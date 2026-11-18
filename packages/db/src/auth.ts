// Auth: password sessions + PAT verification for web and git transport.
// Deliberately dependency-light: scrypt hashing (node:crypto), token in DB.
// Better-Auth was evaluated; for this MVP we own a tiny, auditable surface.

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "./db";
import { users, sessions, personalAccessTokens, sshKeys } from "./schema";

const SESSION_DAYS = 30;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ---------- sessions ----------

export async function createSession(userId: number): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db.insert(sessions).values({ token, userId, expiresAt });
  return token;
}

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  handle: string;
  avatarUrl: string | null;
}

export async function userFromSessionToken(token: string | undefined | null): Promise<AuthUser | null> {
  if (!token) return null;
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      handle: users.handle,
      avatarUrl: users.avatarUrl,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export async function destroySession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.token, token));
}

export async function registerUser(email: string, name: string, handle: string, password: string): Promise<AuthUser> {
  const passwordHash = hashPassword(password);
  const [row] = await db
    .insert(users)
    .values({ email, name, handle, passwordHash })
    .returning({ id: users.id, email: users.email, name: users.name, handle: users.handle, avatarUrl: users.avatarUrl });
  if (!row) throw new Error("registration failed");
  return row;
}

export async function loginUser(email: string, password: string): Promise<AuthUser | null> {
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = rows[0];
  if (!user) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return { id: user.id, email: user.email, name: user.name, handle: user.handle, avatarUrl: user.avatarUrl };
}

// ---------- personal access tokens ----------

export interface PatRecord {
  id: number;
  userId: number;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: Date | null;
}

export async function createPat(userId: number, name: string, scopes: string[]): Promise<{ record: PatRecord; token: string }> {
  const secret = randomBytes(24).toString("base64url");
  const token = `forge_pat_${secret}`;
  const tokenHash = sha256Hex(token);
  const prefix = token.slice(0, 14);
  const [row] = await db
    .insert(personalAccessTokens)
    .values({ userId, name, tokenHash, prefix, scopes })
    .returning({ id: personalAccessTokens.id, prefix: personalAccessTokens.prefix, scopes: personalAccessTokens.scopes, name: personalAccessTokens.name, lastUsedAt: personalAccessTokens.lastUsedAt, userId: personalAccessTokens.userId });
  if (!row) throw new Error("pat creation failed");
  return { record: row, token };
}

export async function verifyPat(token: string): Promise<{ userId: number; scopes: string[] } | null> {
  const tokenHash = sha256Hex(token);
  const rows = await db
    .select({ userId: personalAccessTokens.userId, scopes: personalAccessTokens.scopes })
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // fire-and-forget lastUsed update
  void db
    .update(personalAccessTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(personalAccessTokens.tokenHash, tokenHash));
  return { userId: row.userId, scopes: row.scopes };
}

// ---------- ssh keys ----------

export function sshFingerprint(publicKey: string): string {
  // sha256 fingerprint of the decoded key blob
  const parts = publicKey.trim().split(/\s+/);
  const blob = parts[1];
  if (!blob) return "unknown";
  const decoded = Buffer.from(blob, "base64");
  const hash = createHash("sha256").update(decoded).digest("base64").replace(/=+$/, "");
  return `SHA256:${hash}`;
}

export async function addSshKey(userId: number, title: string, publicKey: string): Promise<void> {
  const fingerprint = sshFingerprint(publicKey);
  await db.insert(sshKeys).values({ userId, title, fingerprint, publicKey });
}

export async function listSshKeys(userId: number): Promise<Array<{ id: number; title: string; fingerprint: string; createdAt: Date }>> {
  return db
    .select({ id: sshKeys.id, title: sshKeys.title, fingerprint: sshKeys.fingerprint, createdAt: sshKeys.createdAt })
    .from(sshKeys)
    .where(eq(sshKeys.userId, userId))
    .orderBy(sql`${sshKeys.id} desc`);
}

export async function deleteSshKey(userId: number, keyId: number): Promise<void> {
  await db.delete(sshKeys).where(and(eq(sshKeys.id, keyId), eq(sshKeys.userId, userId)));
}
