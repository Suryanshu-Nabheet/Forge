"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { Markdown } from "@/components/Markdown";
import type { QaAnswer } from "@forge/shared";

export default function AskPage() {
  const { org, repo } = useParams<{ org: string; repo: string }>();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<QaAnswer | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask() {
    if (!question.trim()) return;
    setBusy(true);
    setAnswer(null);
    try {
      const res = await fetch(`/api/${org}/${repo}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = (await res.json()) as QaAnswer & { error?: string };
      if (data.error) setAnswer({ question, answer: `Error: ${data.error}`, citations: [], confidence: 0, mode: "heuristic" });
      else setAnswer(data);
    } catch (err) {
      setAnswer({ question, answer: `Request failed: ${err instanceof Error ? err.message : err}`, citations: [], confidence: 0, mode: "heuristic" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-lg font-semibold mb-1">Ask the codebase</h1>
      <p className="text-[13px] text-[var(--text-dim)] mb-4">
        Semantic search over the indexed branch. Try: “Where is auth handled and how does it fail?”
      </p>

      <div className="flex gap-2 mb-4">
        <input
          className="input"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
          placeholder="Where is auth handled and how does it fail?"
        />
        <button className="btn btn-primary" onClick={ask} disabled={busy || !question.trim()}>
          {busy ? "Thinking…" : "Ask"}
        </button>
      </div>

      {busy && <div className="card p-6 text-center text-[var(--text-dim)] text-[13px]">⟳ Retrieving and ranking chunks…</div>}

      {answer && (
        <div className="card p-5">
          <div className="text-[11px] uppercase tracking-wide text-[var(--text-faint)] mb-2">
            {answer.mode} mode · confidence {(answer.confidence * 100).toFixed(0)}%
          </div>
          <Markdown text={answer.answer} className="text-[13px] leading-relaxed" />
          {answer.citations.length > 0 && (
            <div className="mt-4 pt-4 border-t">
              <div className="text-xs uppercase tracking-wide text-[var(--text-faint)] mb-2">Citations</div>
              {answer.citations.map((c, i) => (
                <div key={i} className="mb-2">
                  <div className="mono text-[12px] text-[var(--accent)]">{c.path}:{c.lineStart}–{c.lineEnd}{c.symbol ? ` (${c.symbol})` : ""}</div>
                  <pre className="text-[11.5px] mono text-[var(--text-dim)] mt-1 overflow-x-auto">{c.snippet}</pre>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
