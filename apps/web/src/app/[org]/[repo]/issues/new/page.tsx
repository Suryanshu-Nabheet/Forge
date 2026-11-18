"use client";

import { useState } from "react";
import { useRouter, useParams } from "next/navigation";

export default function NewIntentPage() {
  const router = useRouter();
  const { org: orgSlug, repo: repoName } = useParams<{ org: string; repo: string }>();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<"issue" | "spec" | "intent">("intent");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch(`/api/${orgSlug}/${repoName}/issues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, kind }),
      });
      const data = await res.json();
      if (res.ok) {
        router.push(`/${orgSlug}/${repoName}/issues/${data.number}`);
      } else {
        alert(data.error ?? "failed");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-lg font-semibold mb-4">New intent</h1>
      <div className="card p-5 space-y-4">
        <div>
          <label className="text-[13px] text-[var(--text-dim)] block mb-1">Title</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Rate-limit the auth endpoint" />
        </div>
        <div>
          <label className="text-[13px] text-[var(--text-dim)] block mb-1">Description / spec</label>
          <textarea className="input mono" rows={6} value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="What should happen, why, constraints, acceptance criteria…" />
        </div>
        <div>
          <label className="text-[13px] text-[var(--text-dim)] block mb-1">Kind</label>
          <select className="input" style={{ width: "auto" }} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="intent">intent</option>
            <option value="spec">spec</option>
            <option value="issue">issue</option>
          </select>
        </div>
        <div className="flex justify-end">
          <button className="btn btn-primary" disabled={busy || !title.trim()} onClick={submit}>
            {busy ? "Creating…" : "Create intent"}
          </button>
        </div>
      </div>
    </div>
  );
}
