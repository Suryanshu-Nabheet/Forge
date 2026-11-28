"use client";

// /[org]/[repo]/releases/new — create a release: tag + target + notes.

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";

export default function NewReleasePage() {
  const { org: orgSlug, repo: repoName } = useParams<{ org: string; repo: string }>();
  const router = useRouter();
  const [tagName, setTagName] = useState("");
  const [name, setName] = useState("");
  const [targetRef, setTargetRef] = useState("");
  const [notes, setNotes] = useState("");
  const [prerelease, setPrerelease] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!tagName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/${orgSlug}/${repoName}/releases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tagName: tagName.trim(),
          name: name.trim() || tagName.trim(),
          notes: notes.trim() || undefined,
          targetRef: targetRef.trim() || undefined,
          prerelease,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `failed (${res.status})`);
      router.push(`/${orgSlug}/${repoName}/releases`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-xl">
      <h1 className="text-lg font-semibold mb-4">New release</h1>
      <div className="card p-5 space-y-4">
        <div className="flex gap-3">
          <label className="flex-1">
            <div className="text-xs text-[var(--text-dim)] mb-1">Tag</div>
            <input className="input mono" value={tagName} onChange={(e) => setTagName(e.target.value)}
              placeholder="v1.0.0" />
          </label>
          <label className="flex-1">
            <div className="text-xs text-[var(--text-dim)] mb-1">Target (branch or sha, default: main)</div>
            <input className="input mono" value={targetRef} onChange={(e) => setTargetRef(e.target.value)}
              placeholder="main" />
          </label>
        </div>
        <label className="block">
          <div className="text-xs text-[var(--text-dim)] mb-1">Release title</div>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Version 1.0 — first stable" />
        </label>
        <label className="block">
          <div className="text-xs text-[var(--text-dim)] mb-1">Notes (Markdown)</div>
          <textarea className="input" rows={6} value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder={"## Changes\n- …\n\n## Fixes\n- …"} />
        </label>
        <label className="flex items-center gap-2 text-[13px] text-[var(--text-dim)] cursor-pointer">
          <input type="checkbox" checked={prerelease} onChange={(e) => setPrerelease(e.target.checked)}
            className="accent-[var(--accent)]" />
          pre-release
        </label>
        {error && <div className="text-[13px] text-[var(--red)]">{error}</div>}
        <button className="btn btn-primary" disabled={busy || !tagName.trim()} onClick={submit}>
          {busy ? "Publishing…" : "Publish release"}
        </button>
      </div>
    </div>
  );
}
