"use client";

// Inline comment composer anchored to a diff line (path/line/side), with
// optional threading (inReplyTo for replies).

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DiffCommentBox({ org, repo, number, path, line, side, inReplyTo, onDone }: {
  org: string; repo: string; number: number;
  path?: string; line?: number; side?: "old" | "new";
  inReplyTo?: number;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function submit() {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/${org}/${repo}/pulls/${number}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: text,
          ...(path !== undefined ? { path } : {}),
          ...(line !== undefined ? { line } : {}),
          side: side ?? "new",
          ...(inReplyTo !== undefined ? { inReplyTo } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `failed (${res.status})`);
      setText("");
      setOpen(false);
      onDone?.();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        className="ml-2 text-[10px] text-[var(--text-faint)] hover:text-[var(--accent)]"
        title="Comment on this line"
        onClick={() => setOpen(true)}
      >
        💬
      </button>
    );
  }

  return (
    <div className="my-1.5 p-2 rounded border border-[var(--border-strong)] bg-[var(--bg)]">
      <textarea
        className="input mono text-[12px]"
        rows={2}
        autoFocus
        placeholder={inReplyTo ? "Reply…" : "Leave an inline comment…"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
        }}
      />
      {error && <div className="text-[11px] text-[var(--red)] mt-1">{error}</div>}
      <div className="flex justify-end gap-2 mt-1.5">
        <button className="btn px-2 py-0.5 text-xs" onClick={() => { setOpen(false); setText(""); }}>Cancel</button>
        <button className="btn btn-primary px-2 py-0.5 text-xs" disabled={busy || !text.trim()} onClick={() => void submit()}>
          {busy ? "Posting…" : "Comment"}
        </button>
      </div>
    </div>
  );
}
