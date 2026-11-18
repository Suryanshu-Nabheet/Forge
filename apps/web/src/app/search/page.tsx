"use client";

import { useState } from "react";

interface SearchHit {
  repo: string;
  path: string;
  branch: string;
  lineStart: number;
  lineEnd: number;
  symbol: string | null;
  score: number;
  snippet: string;
}

export default function SearchPage() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q }),
      });
      const data = await res.json();
      setResults(data.results ?? []);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-4xl">
      <h1 className="text-lg font-semibold mb-4">Semantic code search</h1>
      <div className="flex gap-2 mb-5">
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="rate limiting logic, auth failure handling, webhook retries…"
        />
        <button className="btn btn-primary" onClick={run} disabled={busy || !q.trim()}>{busy ? "…" : "Search"}</button>
      </div>

      {results !== null && results.length === 0 && (
        <div className="card p-6 text-center text-[var(--text-dim)] text-[13px]">
          No matches. Repos need a push to be indexed.
        </div>
      )}

      <div className="space-y-3">
        {results?.map((r, i) => (
          <div key={i} className="card p-4">
            <div className="flex items-center gap-2 text-[13px] mb-1.5">
              <a href={`/${r.repo}`} className="text-[var(--accent)] mono">{r.repo}</a>
              <span className="text-[var(--text-faint)]">/</span>
              <span className="mono">{r.path}</span>
              <span className="mono text-xs text-[var(--text-faint)]">:{r.lineStart}–{r.lineEnd}</span>
              <span className="flex-1" />
              <span className="mono text-xs text-[var(--text-faint)]">score {r.score}</span>
            </div>
            {r.symbol && <div className="text-xs text-[var(--purple)] mb-1">◆ {r.symbol}</div>}
            <pre className="text-[12px] mono text-[var(--text-dim)] overflow-x-auto">{r.snippet}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}
