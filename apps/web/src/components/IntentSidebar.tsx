"use client";

// Intent sidebar: status toggle, label editor, title/description editing.
// Talks to PATCH /api/:org/:repo/issues/:number.

import { useState } from "react";
import { useRouter } from "next/navigation";

export function IntentSidebar({ org, repo, number, status, labels, title, description }: {
  org: string; repo: string; number: number;
  status: string; labels: string[]; title: string; description: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(title);
  const [descDraft, setDescDraft] = useState(description);

  async function patch(body: Record<string, unknown>, tag: string) {
    setBusy(tag);
    setError(null);
    try {
      const res = await fetch(`/api/${org}/${repo}/issues/${number}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `failed (${res.status})`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const closable = status === "open" || status === "in_progress" || status === "in_review";

  return (
    <div className="space-y-4">
      {error && <div className="text-[13px] text-[var(--red)]">{error}</div>}

      <div className="card p-4 space-y-3">
        <div className="text-xs uppercase tracking-wide text-[var(--text-faint)]">Status</div>
        <div className="text-[13px]">{status.replace("_", " ")}</div>
        <div className="flex gap-2">
          {status === "closed" ? (
            <button className="btn text-xs" disabled={busy !== null} onClick={() => void patch({ status: "open" }, "status")}>
              Reopen
            </button>
          ) : (
            <button className="btn text-xs" disabled={busy !== null || !closable}
              onClick={() => void patch({ status: "closed" }, "status")}>
              Close
            </button>
          )}
        </div>
      </div>

      <div className="card p-4 space-y-3">
        <div className="text-xs uppercase tracking-wide text-[var(--text-faint)]">Labels</div>
        <div className="flex flex-wrap gap-1.5">
          {labels.length === 0 && <span className="text-[12px] text-[var(--text-faint)]">none</span>}
          {labels.map((l) => (
            <button key={l} title="Remove label"
              className="text-[10px] border border-[var(--border-strong)] rounded-full px-2 py-px text-[var(--text-dim)] hover:border-[var(--red)] hover:text-[var(--red)]"
              disabled={busy !== null}
              onClick={() => void patch({ labels: labels.filter((x) => x !== l) }, `label-${l}`)}>
              {l} ×
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            className="input text-[12px]"
            placeholder="add label…"
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && labelDraft.trim()) {
                void patch({ labels: [...labels, labelDraft.trim()] }, "label-add");
                setLabelDraft("");
              }
            }}
          />
          <button
            className="btn text-xs"
            disabled={busy !== null || !labelDraft.trim()}
            onClick={() => {
              void patch({ labels: [...labels, labelDraft.trim()] }, "label-add");
              setLabelDraft("");
            }}
          >Add</button>
        </div>
      </div>

      <div className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wide text-[var(--text-faint)]">Details</div>
          <button className="btn px-2 py-0.5 text-xs" onClick={() => setEditing((v) => !v)}>
            {editing ? "Cancel" : "Edit"}
          </button>
        </div>
        {editing ? (
          <div className="space-y-2">
            <input className="input text-[13px]" value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} />
            <textarea className="input text-[12.5px]" rows={5} value={descDraft} onChange={(e) => setDescDraft(e.target.value)} />
            <button className="btn btn-primary text-xs" disabled={busy !== null || !titleDraft.trim()}
              onClick={() => {
                void patch({ title: titleDraft, description: descDraft }, "edit");
                setEditing(false);
              }}
            >Save</button>
          </div>
        ) : (
          <div className="text-[12px] text-[var(--text-faint)]">title &amp; description editable</div>
        )}
      </div>
    </div>
  );
}
