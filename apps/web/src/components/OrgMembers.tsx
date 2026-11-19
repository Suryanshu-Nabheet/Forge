"use client";

// Org members panel: list + owner-only add/remove.

import { useEffect, useState } from "react";

interface Member {
  id: number;
  userId: number;
  role: string;
  name: string;
  handle: string;
}

export function OrgMembers({ org, you }: { org: string; you: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    const res = await fetch(`/api/orgs/${org}/members`);
    if (res.ok) {
      const data = (await res.json()) as { members: Member[] };
      setMembers(data.members);
    }
    setLoaded(true);
  }
  if (!loaded) void load(), setLoaded(true);

  async function add() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/orgs/${org}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `failed (${res.status})`);
      setHandle("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function remove(userId: number) {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/orgs/${org}/members`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `failed (${res.status})`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  const isOwner = you === "owner";

  return (
    <div className="mt-8">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-[15px] font-semibold">Members</h2>
        <span className="text-xs text-[var(--text-faint)]">{members.length}</span>
      </div>
      <div className="card divide-y">
        {members.map((m) => (
          <div key={m.userId} className="px-4 py-2.5 flex items-center gap-3">
            <span className="text-[13px] font-medium">{m.name}</span>
            <span className="mono text-xs text-[var(--text-faint)]">@{m.handle}</span>
            <span className={`text-[10px] uppercase tracking-wide border rounded-full px-1.5 py-px ${
              m.role === "owner" ? "border-[var(--purple)] text-[var(--purple)]" : "border-[var(--border-strong)] text-[var(--text-faint)]"
            }`}>{m.role}</span>
            <span className="flex-1" />
            {isOwner && m.role !== "owner" && (
              <button className="btn text-xs" disabled={busy} onClick={() => void remove(m.userId)}>Remove</button>
            )}
          </div>
        ))}
      </div>
      {isOwner && (
        <div className="card p-4 mt-3 flex gap-2 items-center">
          <input
            className="input"
            placeholder="Add member by handle (e.g. grace)"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
          />
          <button className="btn btn-primary text-xs" disabled={busy || !handle.trim()} onClick={() => void add()}>
            {busy ? "…" : "Add member"}
          </button>
        </div>
      )}
      {error && <div className="text-[13px] text-[var(--red)] mt-2">{error}</div>}
    </div>
  );
}
