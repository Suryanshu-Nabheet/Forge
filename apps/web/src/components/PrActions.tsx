"use client";

// PR action bar: merge (3 strategies), close, reopen + summary comment form.

import { useState } from "react";
import { useRouter } from "next/navigation";

export function PrActions({ org, repo, number, status, approvals }: {
  org: string; repo: string; number: number;
  status: "open" | "merged" | "closed";
  approvals: Array<{ state: string; by: string }>;
}) {
  const router = useRouter();
  const [strategy, setStrategy] = useState<"merge" | "squash" | "rebase">("squash");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [showComment, setShowComment] = useState(false);

  async function post(path: string, body?: unknown) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
    return data;
  }

  async function merge() {
    setBusy("merge"); setError(null);
    try {
      await post(`/${org}/${repo}/pulls/${number}/merge`, { strategy });
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function setStatus(next: "open" | "closed") {
    setBusy(next); setError(null);
    try {
      await post(`/api/${org}/${repo}/pulls/${number}/status`, { status: next });
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function submitComment() {
    if (!comment.trim()) return;
    setBusy("comment"); setError(null);
    try {
      await post(`/${org}/${repo}/pulls/${number}/comments`, { body: comment });
      setComment("");
      setShowComment(false);
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function review(state: "approved" | "changes_requested" | "revoke") {
    setBusy(`review-${state}`); setError(null);
    try {
      await post(`/api/${org}/${repo}/pulls/${number}/approvals`, { state });
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  const canReview = status === "open";

  return (
    <div className="card p-4 space-y-3">
      {error && <div className="text-[13px] text-[var(--red)]">{error}</div>}

      {approvals.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {approvals.map((a, i) => (
            <span
              key={i}
              className={`text-xs border rounded-full px-2 py-0.5 ${
                a.state === "approved"
                  ? "border-[var(--green)] text-[var(--green)]"
                  : "border-[var(--red)] text-[var(--red)]"
              }`}
            >
              {a.state === "approved" ? "✓" : "⚠"} {a.by}
            </span>
          ))}
        </div>
      )}

      {status === "open" ? (
        <div className="flex items-center gap-2 flex-wrap">
          <select
            className="input"
            style={{ width: "auto" }}
            value={strategy}
            onChange={(e) => setStrategy(e.target.value as typeof strategy)}
          >
            <option value="squash">squash and merge</option>
            <option value="merge">merge commit</option>
            <option value="rebase">rebase and merge</option>
          </select>
          <button className="btn btn-primary" disabled={busy !== null} onClick={merge}>
            {busy === "merge" ? "Merging…" : "Merge pull request"}
          </button>
          <button className="btn" disabled={busy !== null} onClick={() => setStatus("closed")}>
            {busy === "close" ? "Closing…" : "Close"}
          </button>
          <span className="flex-1" />
          {canReview && (
            <>
              <button
                className="btn"
                title="Approve this pull request"
                disabled={busy !== null}
                onClick={() => review("approved")}
              >
                {busy === "review-approved" ? "…" : "Approve"}
              </button>
              <button
                className="btn"
                title="Request changes"
                disabled={busy !== null}
                onClick={() => review("changes_requested")}
              >
                {busy === "review-changes_requested" ? "…" : "Request changes"}
              </button>
            </>
          )}
          <button className="btn" onClick={() => setShowComment((v) => !v)}>Comment</button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-[var(--text-dim)]">This PR is {status}.</span>
          {status === "closed" && (
            <button className="btn" disabled={busy !== null} onClick={() => setStatus("open")}>
              {busy === "open" ? "Reopening…" : "Reopen"}
            </button>
          )}
        </div>
      )}

      {showComment && (
        <div className="space-y-2 pt-2 border-t">
          <textarea
            className="input mono"
            rows={3}
            placeholder="Leave a comment…"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={() => setShowComment(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy !== null || !comment.trim()} onClick={submitComment}>
              {busy === "comment" ? "Posting…" : "Comment"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
