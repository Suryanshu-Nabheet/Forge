"use client";

import { useEffect, useState } from "react";

interface Delivery {
  id: number;
  event: string;
  status: "pending" | "delivered" | "failed";
  responseStatus: number | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}

interface Hook {
  id: number;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
  deliveries: Delivery[];
}

/** Webhook management panel on the repo settings page. */
export function WebhooksPanel({ org, repo }: { org: string; repo: string }) {
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["push"]);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    const res = await fetch(`/api/${org}/${repo}/hooks`);
    if (res.ok) {
      const data = (await res.json()) as { webhooks: Hook[] };
      setHooks(data.webhooks ?? []);
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "cannot load webhooks");
    }
    setLoaded(true);
  }
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleEvent(e: string) {
    setEvents((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]));
  }

  async function create() {
    if (!url.trim()) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/${org}/${repo}/hooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), events }),
      });
      const data = (await res.json()) as { secret?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `failed (${res.status})`);
      setNewSecret(data.secret ?? null);
      setUrl("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/${org}/${repo}/hooks`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `failed (${res.status})`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function redeliver(deliveryId: number) {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/${org}/${repo}/hooks`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "redeliver", deliveryId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `failed (${res.status})`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <div className="text-[13px] text-[var(--text-dim)]">loading…</div>;

  return (
    <div className="space-y-4">
      {error && <div className="text-[13px] text-[var(--red)]">{error}</div>}

      {newSecret && (
        <div className="card p-3 border-[var(--accent)]">
          <div className="text-[13px] font-medium mb-1">Webhook secret (shown once)</div>
          <div className="flex items-center gap-2">
            <code className="mono text-xs break-all flex-1 text-[var(--accent)]">{newSecret}</code>
            <button className="btn text-xs" onClick={() => void navigator.clipboard.writeText(newSecret)}>Copy</button>
          </div>
          <p className="text-xs text-[var(--text-faint)] mt-1">
            Verify deliveries with <code className="mono">sha256=HMAC(secret, body)</code> from <code className="mono">X-Forge-Signature</code>.
          </p>
        </div>
      )}

      <div className="card p-4 space-y-3">
        <div className="flex gap-3 flex-wrap">
          <input
            className="input mono flex-1"
            style={{ minWidth: "260px" }}
            placeholder="https://ci.example.com/hooks/forge"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="btn btn-primary text-xs" disabled={busy || !url.trim()} onClick={() => void create()}>
            {busy ? "Adding…" : "Add webhook"}
          </button>
        </div>
        <div className="flex items-center gap-3 flex-wrap text-[13px]">
          <span className="text-[var(--text-dim)]">events:</span>
          {["push", "pull_request", "pr_merged", "ping"].map((e) => (
            <label key={e} className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={events.includes(e)}
                onChange={() => toggleEvent(e)}
                className="accent-[var(--accent)]"
              />
              <span className="mono text-xs">{e}</span>
            </label>
          ))}
        </div>
      </div>

      {hooks.length === 0 ? (
        <div className="text-[13px] text-[var(--text-dim)]">No webhooks registered.</div>
      ) : (
        <div className="space-y-3">
          {hooks.map((h) => (
            <div key={h.id} className="card p-4">
              <div className="flex items-center gap-2 flex-wrap">
                <code className="mono text-xs break-all flex-1 text-[var(--accent)]">{h.url}</code>
                <span className={`text-[10px] uppercase ${h.active ? "text-[var(--green)]" : "text-[var(--text-faint)]"}`}>
                  {h.active ? "active" : "inactive"}
                </span>
                <button
                  className="btn text-xs"
                  style={{ borderColor: "var(--red)", color: "var(--red)" }}
                  disabled={busy}
                  onClick={() => void remove(h.id)}
                >
                  Delete
                </button>
              </div>
              <div className="text-xs text-[var(--text-faint)] mt-1">
                events: {h.events.map((e) => <span key={e} className="mono mr-1.5">{e}</span>)}
              </div>
              {h.deliveries.length > 0 && (
                <div className="mt-3 border-t pt-2">
                  <div className="text-[11px] uppercase tracking-wide text-[var(--text-faint)] mb-1.5">recent deliveries</div>
                  <div className="space-y-1">
                    {h.deliveries.slice(0, 5).map((d) => (
                      <div key={d.id} className="flex items-center gap-2 text-xs mono">
                        <span className={d.status === "delivered" ? "text-[var(--green)]" : d.status === "failed" ? "text-[var(--red)]" : "text-[var(--text-faint)]"}>
                          {d.status === "delivered" ? "✓" : "✕"} {d.status}
                        </span>
                        <span className="text-[var(--text-dim)]">{d.event}</span>
                        {d.responseStatus !== null && <span className="text-[var(--text-faint)]">HTTP {d.responseStatus}</span>}
                        {d.durationMs !== null && <span className="text-[var(--text-faint)]">{d.durationMs}ms</span>}
                        {d.error && <span className="text-[var(--red)] truncate max-w-48" title={d.error}>{d.error}</span>}
                        <span className="flex-1" />
                        <button
                          className="btn px-1.5 py-0.5 text-[10px]"
                          disabled={busy}
                          title="Retry this delivery"
                          onClick={() => void redeliver(d.id)}
                        >
                          ⟳
                        </button>
                        <span className="text-[var(--text-faint)]">{new Date(d.createdAt).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
