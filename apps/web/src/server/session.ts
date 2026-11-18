// Session helpers for API route handlers: read forge_session cookie, resolve user.

import { cookies } from "next/headers";
import { userFromSessionToken, type AuthUser } from "@forge/db";

export type { AuthUser };

export async function currentUser(): Promise<AuthUser | null> {
  const jar = await cookies();
  return userFromSessionToken(jar.get("forge_session")?.value ?? null);
}

/** Route-handler gate: returns the user, or null when the caller must 401. */
export async function requireUser(): Promise<AuthUser | null> {
  return currentUser();
}

export function unauthorized(message = "authentication required"): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
