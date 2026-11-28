// Auth: password sessions + PAT verification for web and git transport.
// Deliberately dependency-light: scrypt hashing (node:crypto), token in DB.
// Better-Auth was evaluated; for this MVP we own a tiny, auditable surface.

import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { and, eq, gt, lt, sql, desc } from "drizzle-orm";
import { db } from "./db";
import { users, sessions, personalAccessTokens, sshKeys, auditLog, type AuditAction } from "./schema";

const SESSION_DAYS = 30;

// scrypt parameters, versioned so they can be raised without breaking
// existing hashes. Format: "scrypt:<N>:<r>:<p>:<salt>:<hash>" (new) or
// "<salt>:<hash>" (legacy, N=16384 r=8 p=1 — Node defaults at write time).
const SCRYPT_N = 2 ** 15;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEYLEN = 64;
const LEGACY_SCRYPT_N = 16384;

// Fixed dummy hash (same cost as a real one) used to equalize timing on
// unknown-email login attempts. Regenerate with hashPassword() if the
// parameters above change.
const DUMMY_HASH = hashPassword("forge-timing-equalizer");

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, maxmem: 64 * 1024 * 1024 }).toString("hex");
  return `scrypt:${SCRYPT_N}:${SCRYPT_r}:${SCRYPT_p}:${salt}:${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const { N, r, p, salt, hash } = parsed;
  const candidate = await new Promise<Buffer | null>((resolve) => {
    scrypt(password, salt, SCRYPT_KEYLEN, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, derived) => {
      resolve(err ? null : derived);
    });
  });
  if (!candidate) return false;
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function parseStoredHash(stored: string): { N: number; r: number; p: number; salt: string; hash: string } | null {
  const parts = stored.split(":");
  if (parts.length === 6 && parts[0] === "scrypt") {
    const [, nStr, rStr, pStr, salt, hash] = parts;
    const N = Number(nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N <= 0) return null;
    return { N, r, p, salt, hash };
  }
  // Legacy "salt:hash" (two hex segments) written before versioning.
  if (parts.length === 2 && /^[0-9a-f]+$/i.test(parts[0]!) && /^[0-9a-f]+$/i.test(parts[1]!)) {
    return { N: LEGACY_SCRYPT_N, r: 8, p: 1, salt: parts[0]!, hash: parts[1]! };
  }
  return null;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ---------- sessions ----------

export async function createSession(userId: number): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  // Store only the sha256 of the token: a DB read must not yield usable sessions.
  await db.insert(sessions).values({ token: sha256Hex(token), userId, expiresAt });
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
    .where(and(eq(sessions.token, sha256Hex(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export async function destroySession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.token, sha256Hex(token)));
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
  if (!user) {
    // Equalize timing so unknown emails don't reveal account existence.
    await verifyPassword(password, DUMMY_HASH);
    return null;
  }
  if (!(await verifyPassword(password, user.passwordHash))) return null;
  return { id: user.id, email: user.email, name: user.name, handle: user.handle, avatarUrl: user.avatarUrl };
}

// ---------- login rate limiting (brute-force protection) ----------
// In-memory sliding window keyed by email+ip; 5 failures/min → 429 territory.
// The map is pruned periodically so spraying distinct email|ip pairs cannot
// grow it without bound. (Single-process only, like the rest of the MVP.)
const MAX_FAILURES = 5;
const WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 10_000;
const failures = new Map<string, number[]>();

// ---------- Redis-backed limiter (multi-replica deployments) ----------
// Feature-detected: REDIS_URL set → shared sliding window across replicas.
// Absent → the in-memory Map below (single-process topology). Same API,
// same semantics; Redis failures degrade to in-memory rather than
// locking people out.

interface RedisLike {
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  rpush(key: string, ...values: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<"OK" | null>;
  expire(key: string, seconds: number): Promise<number>;
  del(key: string, ...keys: string[]): Promise<number>;
}

let redis: RedisLike | null = null;
let redisInit: Promise<RedisLike | null> | null = null;

async function getRedis(): Promise<RedisLike | null> {
  if (redis) return redis;
  if (!redisInit) {
    redisInit = (async () => {
      if (!process.env.REDIS_URL) return null;
      try {
        const mod = await import("ioredis");
        const client = new mod.default(process.env.REDIS_URL, {
          lazyConnect: false,
          maxRetriesPerRequest: 1,
          connectTimeout: 2000,
        });
        client.on("error", (err) => console.error("[db] redis error:", err.message));
        return client as unknown as RedisLike;
      } catch {
        return null;
      }
    })();
  }
  redis = await redisInit;
  return redis;
}

const failuresKey = (email: string, ip: string) => `forge:loginfail:${Buffer.from(`${email}|${ip}`).toString("base64url")}`;

async function redisBlocked(email: string, ip: string): Promise<boolean | null> {
  const r = await getRedis();
  if (!r) return null;
  try {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    const key = failuresKey(email, ip);
    const raw = await r.lrange(key, 0, -1);
    const fresh = raw.map(Number).filter((t) => t > cutoff);
    await r.ltrim(key, -MAX_FAILURES * 2, -1);
    return fresh.length >= MAX_FAILURES;
  } catch {
    return null; // degrade to in-memory
  }
}

async function redisRecord(email: string, ip: string): Promise<void> {
  const r = await getRedis();
  if (!r) return;
  try {
    const key = failuresKey(email, ip);
    await r.rpush(key, String(Date.now()));
    await r.expire(key, Math.ceil(WINDOW_MS / 1000) + 5);
  } catch { /* degrade */ }
}

async function redisClear(email: string, ip: string): Promise<void> {
  const r = await getRedis();
  if (!r) return;
  try {
    await r.del(failuresKey(email, ip));
  } catch { /* degrade */ }
}

// The public API stays synchronous-looking to callers; the login route
// awaits the async variants when Redis is configured.
export async function loginBlockedAsync(email: string, ip: string): Promise<boolean> {
  const viaRedis = await redisBlocked(email, ip);
  if (viaRedis !== null) return viaRedis;
  return loginBlocked(email, ip);
}

export async function recordLoginFailureAsync(email: string, ip: string): Promise<void> {
  await redisRecord(email, ip);
  recordLoginFailure(email, ip); // in-memory fallback covers the Redis-less case
}

export async function clearLoginFailuresAsync(email: string, ip: string): Promise<void> {
  await redisClear(email, ip);
  clearLoginFailures(email, ip);
}

function pruneFailures(now: number): void {
  for (const [key, list] of failures) {
    const fresh = list.filter((t) => now - t < WINDOW_MS);
    if (fresh.length === 0) failures.delete(key);
    else failures.set(key, fresh);
  }
}

export function loginBlocked(email: string, ip: string): boolean {
  const now = Date.now();
  if (failures.size > MAX_TRACKED_KEYS) pruneFailures(now);
  const key = `${email}|${ip}`;
  const list = (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  failures.set(key, list);
  return list.length >= MAX_FAILURES;
}

export function recordLoginFailure(email: string, ip: string): void {
  const now = Date.now();
  if (failures.size > MAX_TRACKED_KEYS) pruneFailures(now);
  const key = `${email}|${ip}`;
  const list = failures.get(key) ?? [];
  list.push(now);
  failures.set(key, list);
}

export function clearLoginFailures(email: string, ip: string): void {
  failures.delete(`${email}|${ip}`);
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

export async function createPat(
  userId: number,
  name: string,
  scopes: string[],
  opts?: { expiresInDays?: number },
): Promise<{ record: PatRecord; token: string }> {
  const secret = randomBytes(24).toString("base64url");
  const token = `forge_pat_${secret}`;
  const tokenHash = sha256Hex(token);
  const prefix = token.slice(0, 14);
  const expiresAt = opts?.expiresInDays
    ? new Date(Date.now() + opts.expiresInDays * 86400_000)
    : null;
  const [row] = await db
    .insert(personalAccessTokens)
    .values({ userId, name, tokenHash, prefix, scopes, expiresAt })
    .returning({ id: personalAccessTokens.id, prefix: personalAccessTokens.prefix, scopes: personalAccessTokens.scopes, name: personalAccessTokens.name, lastUsedAt: personalAccessTokens.lastUsedAt, userId: personalAccessTokens.userId });
  if (!row) throw new Error("pat creation failed");
  return { record: row, token };
}

export async function verifyPat(token: string): Promise<{ userId: number; scopes: string[] } | null> {
  const tokenHash = sha256Hex(token);
  const rows = await db
    .select({ userId: personalAccessTokens.userId, scopes: personalAccessTokens.scopes, expiresAt: personalAccessTokens.expiresAt, revokedAt: personalAccessTokens.revokedAt })
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  // fire-and-forget lastUsed update (never crash the request path)
  db
    .update(personalAccessTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(personalAccessTokens.tokenHash, tokenHash))
    .catch(() => {});
  return { userId: row.userId, scopes: row.scopes };
}

export async function revokePat(userId: number, patId: number): Promise<void> {
  // Soft-revoke: keep the row (hash + name) for audit, reject on verify.
  await db
    .update(personalAccessTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(personalAccessTokens.id, patId), eq(personalAccessTokens.userId, userId)));
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

// ---------- audit log ----------

export interface AuditEntry {
  actorId: number | null;
  actorHandle: string | null;
  action: AuditAction | string;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  data?: Record<string, unknown>;
}

/** Append an audit event. Never throws into the caller — audit failures are
 * logged but must not fail the user-facing operation that triggered them. */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values({
      actorId: entry.actorId,
      actorHandle: entry.actorHandle,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      ip: entry.ip ?? null,
      data: entry.data ?? {},
    });
  } catch (err) {
    console.error("[audit] failed to record:", entry.action, err);
  }
}

/** Recent audit events, newest first (admin/observability surface). */
export async function recentAudit(limit = 100) {
  return db
    .select({
      id: auditLog.id,
      actorId: auditLog.actorId,
      actorHandle: auditLog.actorHandle,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      ip: auditLog.ip,
      data: auditLog.data,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .orderBy(desc(auditLog.id))
    .limit(limit);
}
