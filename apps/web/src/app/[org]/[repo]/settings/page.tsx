"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { WebhooksPanel } from "@/components/WebhooksPanel";

interface Settings {
  protectedBranches: string[];
  visibility: "public" | "private";
}

export default function RepoSettingsPage() {
  const { org: orgSlug, repo: repoName } = useParams<{ org: string; repo: string }>();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    const res = await fetch(`/api/${orgSlug}/${repoName}/settings`);
    if (res.ok) {
      const data = (await res.json()) as Settings;
      setSettings(data);
      setDraft(data.protectedBranches.join(", "));
    } else {
      setError("cannot load settings");
    }
    setLoaded(true);
  }
  useEffect(() => { void load(); }, [orgSlug, repoName]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setBusy(true); setError(null);
    try {
      const branches = draft.split(",").map((b) => b.trim()).filter(Boolean);
      const res = await fetch(`/api/${orgSlug}/${repoName}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protectedBranches: branches }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `failed (${res.status})`);
      setSettings({ ...(settings as Settings), protectedBranches: branches });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!settings) {
    return <div className="text-[var(--text-dim)] text-[13px]">{error ?? "loading…"}</div>;
  }

  async function deleteRepo() {
    if (!confirm(`Delete ${orgSlug}/${repoName} permanently? This removes all code, PRs, issues, and history.`)) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/orgs/${orgSlug}/repos/${repoName}`, { method: "DELETE" });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `failed (${res.status})`);
      window.location.href = `/${orgSlug}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="max-w-xl space-y-6">
      <section>
        <h2 className="text-lg font-semibold mb-1">Branch protection</h2>
        <p className="text-[13px] text-[var(--text-dim)] mb-3">
          Protected branches reject force-pushes and deletions. Merging into a protected branch
          requires at least one approving review. Owner only. Comma-separated list.
        </p>
        <div className="card p-4 space-y-3">
          <input
            className="input mono"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="main, release"
          />
          {error && <div className="text-[13px] text-[var(--red)]">{error}</div>}
          <div className="flex items-center gap-3">
            <button className="btn btn-primary" disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save protection rules"}
            </button>
            <span className="text-xs text-[var(--text-faint)]">
              {settings.protectedBranches.length} protected
            </span>
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-1">Webhooks</h2>
        <p className="text-[13px] text-[var(--text-dim)] mb-3">
          Deliver signed event payloads (push, pull_request, pr_merged, ping) to your endpoints.
          Each delivery is HMAC-SHA256 signed with a per-hook secret (<code className="mono">X-Forge-Signature</code>).
        </p>
        <WebhooksPanel org={orgSlug} repo={repoName} />
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-1" style={{ color: "var(--red)" }}>Danger zone</h2>
        <p className="text-[13px] text-[var(--text-dim)] mb-3">
          Deleting a repository erases its git history, pull requests, intents, and index. This cannot be undone.
        </p>
        <button className="btn" style={{ borderColor: "var(--red)", color: "var(--red)" }} disabled={busy} onClick={deleteRepo}>
          Delete this repository
        </button>
      </section>
    </div>
  );
}
