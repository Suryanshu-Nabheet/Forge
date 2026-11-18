"use client";

import { useState } from "react";
import { useRouter, useParams } from "next/navigation";

interface BranchInfo {
  branches: string[];
  defaultBranch: string;
}

export default function NewPullPage() {
  const router = useRouter();
  const { org: orgSlug, repo: repoName } = useParams<{ org: string; repo: string }>();
  const [info, setInfo] = useState<BranchInfo | null>(null);
  const [head, setHead] = useState("");
  const [base, setBase] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    const res = await fetch(`/api/${orgSlug}/${repoName}/pulls/new`, { method: "GET" });
    if (res.ok) {
      const data = (await res.json()) as BranchInfo;
      setInfo(data);
      setBase(data.defaultBranch);
      if (data.branches.length > 0 && data.defaultBranch) {
        const firstOther = data.branches.find((b) => b !== data.defaultBranch);
        if (firstOther) setHead(firstOther);
      }
    }
    setLoaded(true);
  }
  if (!loaded) void load(), setLoaded(true);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/${orgSlug}/${repoName}/pulls/new`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, head, base, description }),
      });
      const data = await res.json();
      if (res.ok) {
        router.push(`/${orgSlug}/${repoName}/pulls/${data.number}`);
      } else {
        setError(data.error ?? "failed to create pull request");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-xl">
      <h1 className="text-lg font-semibold mb-4">New pull request</h1>
      <div className="card p-5 space-y-4">
        <div className="flex gap-3">
          <label className="flex-1">
            <div className="text-xs text-[var(--text-dim)] mb-1">Base branch</div>
            <select className="input" value={base} onChange={(e) => setBase(e.target.value)}>
              {(info?.branches ?? []).map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          <span className="self-end text-[var(--text-faint)] pb-2">←</span>
          <label className="flex-1">
            <div className="text-xs text-[var(--text-dim)] mb-1">Head branch</div>
            <select className="input" value={head} onChange={(e) => setHead(e.target.value)}>
              {(info?.branches ?? []).map((b) => <option key={b} value={b}>{b}</option>)}
              {!head && <option value="">choose…</option>}
            </select>
          </label>
        </div>
        <label className="block">
          <div className="text-xs text-[var(--text-dim)] mb-1">Title</div>
          <input className="input" placeholder="Merge feature X into main" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="block">
          <div className="text-xs text-[var(--text-dim)] mb-1">Description (optional)</div>
          <textarea className="input" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {error && <div className="text-[13px] text-[var(--red)]">{error}</div>}
        <button className="btn btn-primary" disabled={busy || !head || !base || head === base} onClick={submit}>
          {busy ? "Creating…" : "Create pull request"}
        </button>
      </div>
    </div>
  );
}
