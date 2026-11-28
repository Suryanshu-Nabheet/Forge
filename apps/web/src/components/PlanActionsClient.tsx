"use client";

// Intent page actions: draft an implementation plan / create a branch
// scaffold via fetch, with inline status + error display (no page-navigating
// form posts to JSON endpoints).

import { useState } from "react";
import { useRouter } from "next/navigation";

export function PlanActionsClient({ org, repo, number, hasPlan }: {
  org: string; repo: string; number: number; hasPlan: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"plan" | "scaffold" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(action: "plan" | "scaffold") {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/${org}/${repo}/issues/${number}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; branch?: string; queued?: boolean; existing?: boolean };
      if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
      setNotice(
        action === "plan"
          ? "Plan queued — it appears on this page when ready."
          : data.existing
            ? `Branch already exists: ${data.branch}`
            : `Scaffold branch created: ${data.branch}`,
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button className="btn btn-primary" disabled={busy !== null} onClick={() => run("plan")}>
          {busy === "plan" ? "⟳ Drafting plan…" : hasPlan ? "Re-draft plan" : "Draft implementation plan"}
        </button>
        <button className="btn" disabled={busy !== null} onClick={() => run("scaffold")}>
          {busy === "scaffold" ? "⟳ Creating scaffold…" : "Create branch scaffold"}
        </button>
      </div>
      {notice && <div className="text-[13px] text-[var(--green)]">{notice}</div>}
      {error && <div className="text-[13px] text-[var(--red)]">{error}</div>}
    </div>
  );
}
