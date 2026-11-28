"use client";

// Intent discussion thread: top-level comments + replies, posting to
// /api/:org/:repo/issues/:number/comments.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Markdown } from "@/components/Markdown";
import { DiffCommentBox } from "@/components/DiffCommentBox";

export interface IntentComment {
  id: number;
  body: string;
  inReplyTo: number | null;
  authorHandle: string | null;
  authorName: string | null;
  createdAt: string;
}

export function IntentDiscussion({ org, repo, number, initial }: {
  org: string; repo: string; number: number; initial: IntentComment[];
}) {
  const router = useRouter();
  const [loaded, setLoaded] = useState(true);
  const [comments] = useState(initial);
  void setLoaded;

  const topLevel = comments.filter((c) => c.inReplyTo === null);
  const replies = (id: number) => comments.filter((c) => c.inReplyTo === id);

  return (
    <div>
      <h2 className="text-base font-semibold mb-2">Discussion</h2>
      <div className="card p-4">
        <div className="mb-3">
          <DiffCommentBox
            org={org}
            repo={repo}
            number={number}
            onDone={() => router.refresh()}
          />
        </div>
        {topLevel.length === 0 && (
          <div className="text-[13px] text-[var(--text-dim)]">No comments yet.</div>
        )}
        <div className="space-y-3">
          {topLevel.map((c) => (
            <div key={c.id} className="p-2.5 rounded border border-[var(--border-strong)]">
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-faint)] mb-1">
                {c.authorHandle ?? "someone"} · {new Date(c.createdAt).toLocaleString()}
              </div>
              <Markdown text={c.body} className="text-[13px] leading-relaxed" />
              <div className="mt-2 pl-3 border-l-2 border-[var(--border-strong)] space-y-2">
                {replies(c.id).map((rc) => (
                  <div key={rc.id}>
                    <div className="text-[10px] uppercase tracking-wide text-[var(--text-faint)] mb-0.5">
                      {rc.authorHandle ?? "someone"} replied · {new Date(rc.createdAt).toLocaleString()}
                    </div>
                    <Markdown text={rc.body} className="text-[12.5px] leading-relaxed" />
                  </div>
                ))}
                <DiffCommentBox org={org} repo={repo} number={number} inReplyTo={c.id} onDone={() => router.refresh()} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
