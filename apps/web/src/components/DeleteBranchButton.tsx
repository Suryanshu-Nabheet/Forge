"use client";

// Branch deletion with confirmation; posts to the branches API and
// refreshes. Protected branches are rejected server-side too.

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DeleteBranchButton({ org, repo, branch }: { org: string; repo: string; branch: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function del() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/${org}/${repo}/branches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", branch }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `failed (${res.status})`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {error && <span className="text-[11px] text-[var(--red)]">{error}</span>}
      {confirming ? (
        <>
          <button className="btn px-2 py-0.5 text-xs" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
          <button className="btn px-2 py-0.5 text-xs" disabled={busy}
            style={{ borderColor: "var(--red)", color: "var(--red)" }} onClick={() => void del()}>
            {busy ? "Deleting…" : "Confirm delete"}
          </button>
        </>
      ) : (
        <button className="btn px-2 py-0.5 text-xs" disabled={busy}
          style={{ borderColor: "var(--red)", color: "var(--red)" }}
          onClick={() => setConfirming(true)}>Delete</button>
      )}
    </span>
  );
}
