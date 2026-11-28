// TOTP (RFC 6238) + recovery codes for two-factor auth.
// Deliberately dependency-light: HMAC-SHA1 via node:crypto, base32 by hand.
// Secrets are AES-256-GCM encrypted at rest under a FORGE_SECRET-derived key.

import { createHmac, createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// ---------- base32 (RFC 4648, no padding) ----------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---------- TOTP core ----------

export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;

/** Generate a TOTP code for a base32 secret at a unix time. */
export function totpCode(secretB32: string, atTimeSeconds = Math.floor(Date.now() / 1000)): string {
  const key = base32Decode(secretB32);
  const counter = Math.floor(atTimeSeconds / TOTP_PERIOD);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32 >>> 0, 4);
  const digest = createHmac("sha1", key).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = (
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff)
  ) % 10 ** TOTP_DIGITS;
  return code.toString().padStart(TOTP_DIGITS, "0");
}

/** Verify a code against the secret with ±1 period of clock skew allowed. */
export function verifyTotp(secretB32: string, code: string, window = 1): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const now = Math.floor(Date.now() / 1000);
  for (let drift = -window; drift <= window; drift++) {
    const candidate = totpCode(secretB32, now + drift * TOTP_PERIOD);
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(code))) return true;
  }
  return false;
}

/** Generate a fresh base32 TOTP secret (160 bits). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

// ---------- secret encryption at rest ----------

function encryptionKey(): Buffer {
  const secret = process.env.FORGE_SECRET ?? process.env.FORGE_HOOK_TOKEN;
  if (!secret) throw new Error("FORGE_SECRET (or FORGE_HOOK_TOKEN) must be set to encrypt TOTP secrets");
  return scryptSync(secret, "forge-totp-v1", 32);
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${enc.toString("base64")}.${tag.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  const [ivB64, encB64, tagB64] = stored.split(".");
  if (!ivB64 || !encB64 || !tagB64) throw new Error("malformed encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encB64, "base64")), decipher.final()]).toString("utf8");
}

// ---------- recovery codes ----------

/** Generate 8 single-use recovery codes (xxxx-xxxx format), return codes + sha256 hashes joined by comma. */
export function generateRecoveryCodes(): { codes: string[]; stored: string } {
  const codes = Array.from({ length: 8 }, () => randomBytes(4).toString("hex").replace(/(.{4})/, "$1-"));
  return { codes, stored: codes.map(hashRecoveryCode).join(",") };
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.trim().toLowerCase()).digest("hex");
}

/** Verify and consume a recovery code against the stored hash list. Returns the new stored list, or null if no match. */
export function consumeRecoveryCode(stored: string, code: string): string | null {
  const hash = hashRecoveryCode(code);
  const list = stored.split(",").filter(Boolean);
  if (!list.includes(hash)) return null;
  return list.filter((h) => h !== hash).join(",");
}
