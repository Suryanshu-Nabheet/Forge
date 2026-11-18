"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewRepoPage() {
  const router = useRouter();
  const [orgSlug, setOrgSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug, name, description, visibility }),
      });
      const data = await res.json();
      if (res.ok) router.push(`/${orgSlug}/${name}`);
      else setError(data.error ?? "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-xl">
      <h1 className="text-lg font-semibold mb-4">New repository</h1>
      <div className="card p-5 space-y-4">
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="text-[13px] text-[var(--text-dim)] block mb-1">Org slug</label>
            <input className="input mono" value={orgSlug} onChange={(e) => setOrgSlug(e.target.value)} placeholder="acme" />
          </div>
          <div className="flex-1">
            <label className="text-[13px] text-[var(--text-dim)] block mb-1">Repository name</label>
            <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="iris" />
          </div>
        </div>
        <div>
          <label className="text-[13px] text-[var(--text-dim)] block mb-1">Description</label>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Service iris" />
        </div>
        <div>
          <label className="text-[13px] text-[var(--text-dim)] block mb-1">Visibility</label>
          <select className="input" style={{ width: "auto" }} value={visibility} onChange={(e) => setVisibility(e.target.value as "public" | "private")}>
            <option value="public">public</option>
            <option value="private">private</option>
          </select>
        </div>
        {error && <div className="text-[13px] text-[var(--red)]">{error}</div>}
        <div className="flex justify-end">
          <button className="btn btn-primary" disabled={busy || !orgSlug.trim() || !name.trim()} onClick={submit}>
            {busy ? "Creating…" : "Create repository"}
          </button>
        </div>
      </div>
    </div>
  );
}
