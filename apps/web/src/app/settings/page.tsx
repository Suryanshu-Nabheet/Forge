"use client";

import { useState, useEffect } from "react";

export default function SettingsPage() {
  const [keys, setKeys] = useState<Array<{ id: number; title: string; fingerprint: string }>>([]);
  const [pats, setPats] = useState<Array<{ id: number; name: string; prefix: string }>>([]);
  const [newPat, setNewPat] = useState<string | null>(null);
  const [patName, setPatName] = useState("");
  const [keyTitle, setKeyTitle] = useState("");
  const [keyBody, setKeyBody] = useState("");

  async function refresh() {
    if (typeof window === "undefined") return; // skip during SSR/prerender
    const [k, p] = await Promise.all([
      fetch("/api/keys").then((r) => r.json()),
      fetch("/api/pats").then((r) => r.json()),
    ]);
    setKeys(k.keys ?? []);
    setPats(p.pats ?? []);
  }
  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function addKey() {
    if (!keyBody.trim()) return;
    await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: keyTitle || "untitled", publicKey: keyBody }),
    });
    setKeyTitle(""); setKeyBody("");
    void refresh();
  }

  async function makePat() {
    if (!patName.trim()) return;
    const res = await fetch("/api/pats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: patName, scopes: ["repo:read", "repo:write"] }),
    });
    const data = await res.json();
    setNewPat(data.token ?? null);
    setPatName("");
    void refresh();
  }

  return (
    <div className="max-w-2xl space-y-8">
      <section>
        <h1 className="text-lg font-semibold mb-3">SSH keys</h1>
        <div className="card divide-y mb-3">
          {keys.length === 0 && <div className="px-4 py-3 text-[13px] text-[var(--text-dim)]">No SSH keys yet.</div>}
          {keys.map((k) => (
            <div key={k.id} className="px-4 py-2.5">
              <div className="text-[13px] font-medium">{k.title}</div>
              <div className="mono text-xs text-[var(--text-faint)]">{k.fingerprint}</div>
            </div>
          ))}
        </div>
        <div className="card p-4 space-y-3">
          <input className="input" placeholder="Key title" value={keyTitle} onChange={(e) => setKeyTitle(e.target.value)} />
          <textarea className="input mono text-[12px]" rows={3} placeholder="ssh-ed25519 AAAA…" value={keyBody} onChange={(e) => setKeyBody(e.target.value)} />
          <button className="btn" onClick={addKey}>Add SSH key</button>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Personal access tokens</h2>
        <div className="card divide-y mb-3">
          {pats.length === 0 && <div className="px-4 py-3 text-[13px] text-[var(--text-dim)]">No tokens yet.</div>}
          {pats.map((p) => (
            <div key={p.id} className="px-4 py-2.5 flex items-center gap-3">
              <span className="text-[13px]">{p.name}</span>
              <span className="mono text-xs text-[var(--text-faint)]">{p.prefix}…</span>
            </div>
          ))}
        </div>
        {newPat && (
          <div className="card p-4 mb-3 border-[var(--green)]">
            <div className="text-[13px] mb-1">Copy this token now — it will not be shown again:</div>
            <div className="mono text-[12px] break-all">{newPat}</div>
          </div>
        )}
        <div className="card p-4 flex gap-2">
          <input className="input" placeholder="Token name (e.g. laptop git)" value={patName} onChange={(e) => setPatName(e.target.value)} />
          <button className="btn btn-primary" onClick={makePat}>Generate</button>
        </div>
      </section>
    </div>
  );
}
