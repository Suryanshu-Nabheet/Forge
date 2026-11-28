"use client";

import { useState, useEffect } from "react";

export default function SettingsPage() {
  const [keys, setKeys] = useState<Array<{ id: number; title: string; fingerprint: string }>>([]);
  const [pats, setPats] = useState<Array<{ id: number; name: string; prefix: string }>>([]);
  const [newPat, setNewPat] = useState<string | null>(null);
  const [patName, setPatName] = useState("");
  const [keyTitle, setKeyTitle] = useState("");
  const [keyBody, setKeyBody] = useState("");
  const [twoFa, setTwoFa] = useState(false);

  async function refresh() {
    if (typeof window === "undefined") return; // skip during SSR/prerender
    const [k, p, t] = await Promise.all([
      fetch("/api/keys").then((r) => r.json()),
      fetch("/api/pats").then((r) => r.json()),
      fetch("/api/2fa").then((r) => r.json()),
    ]);
    setKeys(k.keys ?? []);
    setPats(p.pats ?? []);
    setTwoFa(Boolean(t.enabled));
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

  async function revoke(kind: "keys" | "pats", id: number) {
    await fetch(`/api/${kind}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    void refresh();
  }

  return (
    <div className="max-w-2xl space-y-8">
      <TwoFaPanel enabled={twoFa} onChanged={() => void refresh()} />

      <section>
        <h1 className="text-lg font-semibold mb-3">SSH keys</h1>
        <div className="card divide-y mb-3">
          {keys.length === 0 && <div className="px-4 py-3 text-[13px] text-[var(--text-dim)]">No SSH keys yet.</div>}
          {keys.map((k) => (
            <div key={k.id} className="px-4 py-2.5 flex items-center gap-3">
              <div className="flex-1">
                <div className="text-[13px] font-medium">{k.title}</div>
                <div className="mono text-xs text-[var(--text-faint)]">{k.fingerprint}</div>
              </div>
              <button className="btn text-xs" onClick={() => void revoke("keys", k.id)}>Remove</button>
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
              <span className="flex-1" />
              <button className="btn text-xs" onClick={() => void revoke("pats", p.id)}>Revoke</button>
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

function TwoFaPanel({ enabled, onChanged }: { enabled: boolean; onChanged: () => void }) {
  const [stage, setStage] = useState<"idle" | "enrolling" | "recovery">("idle");
  const [secret, setSecret] = useState("");
  const [otpauthUrl, setOtpauthUrl] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [disableCode, setDisableCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/2fa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error((data.error as string) ?? "request failed");
    return data;
  }

  async function enroll() {
    setBusy(true); setError(null);
    try {
      const data = await post({ action: "enroll" });
      setSecret(String(data.secret ?? ""));
      setOtpauthUrl(String(data.url ?? ""));
      setStage("enrolling");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function confirm() {
    setBusy(true); setError(null);
    try {
      const data = await post({ action: "confirm", code, secret });
      setRecoveryCodes((data.recoveryCodes as string[]) ?? []);
      setStage("recovery");
      setCode("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function disable() {
    setBusy(true); setError(null);
    try {
      await post({ action: "disable", code: disableCode });
      setDisableCode("");
      setStage("idle");
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <section>
      <h2 className="text-lg font-semibold mb-3">Two-factor authentication</h2>
      <div className="card p-4 space-y-3">
        {error && <div className="text-[13px] text-[var(--red)]">{error}</div>}

        {enabled && stage === "idle" && (
          <div className="flex items-center gap-3">
            <span className="text-[13px] text-[var(--green)]">✓ Enabled (TOTP)</span>
            <span className="flex-1" />
            <input className="input mono" style={{ width: 130 }} placeholder="123456" value={disableCode} onChange={(e) => setDisableCode(e.target.value)} />
            <button className="btn text-xs" disabled={busy || !/^\d{6}$/.test(disableCode)} onClick={disable}>Disable</button>
          </div>
        )}

        {!enabled && stage === "idle" && (
          <div className="flex items-center gap-3">
            <span className="text-[13px] text-[var(--text-dim)]">Not enabled. Add a second factor via any TOTP authenticator app.</span>
            <span className="flex-1" />
            <button className="btn btn-primary" disabled={busy} onClick={enroll}>Enable 2FA</button>
          </div>
        )}

        {stage === "enrolling" && (
          <div className="space-y-3">
            <div className="text-[13px]">
              Add this secret to your authenticator app (Google Authenticator, 1Password, Authy…),
              then enter the 6-digit code it shows:
            </div>
            <div className="mono text-[12px] break-all p-2 border rounded bg-[var(--bg)]">{secret}</div>
            {otpauthUrl && <div className="mono text-[10px] text-[var(--text-faint)] break-all">{otpauthUrl}</div>}
            <div className="flex gap-2">
              <input className="input mono" style={{ width: 130 }} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
              <button className="btn btn-primary" disabled={busy || !/^\d{6}$/.test(code)} onClick={confirm}>Confirm &amp; enable</button>
              <button className="btn" disabled={busy} onClick={() => setStage("idle")}>Cancel</button>
            </div>
          </div>
        )}

        {stage === "recovery" && (
          <div className="space-y-3">
            <div className="text-[13px] text-[var(--green)]">Two-factor authentication is now enabled.</div>
            <div className="text-[13px]">Save these single-use recovery codes now — they will not be shown again:</div>
            <div className="grid grid-cols-2 gap-1 mono text-[12px] p-2 border rounded bg-[var(--bg)]">
              {recoveryCodes.map((c) => <div key={c}>{c}</div>)}
            </div>
            <button className="btn btn-primary" onClick={() => { setStage("idle"); setRecoveryCodes([]); onChanged(); }}>Done</button>
          </div>
        )}
      </div>
    </section>
  );
}
