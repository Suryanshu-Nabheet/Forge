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

interface GrepMatch {
  path: string;
  line: number;
  content: string;
}

type Mode = "semantic" | "literal";

export default function SearchPage() {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<Mode>("semantic");
  const [isRegex, setIsRegex] = useState(false);
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [matches, setMatches] = useState<GrepMatch[] | null>(null);
  const [matchRepo, setMatchRepo] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "semantic") {
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q }),
        });
        const data = (await res.json().catch(() => ({}))) as { results?: SearchHit[]; error?: string };
        if (!res.ok) throw new Error(data.error ?? `failed (${res.status})`);
        setResults(data.results ?? []);
        setMatches(null);
      } else {
        // Literal/regex search runs across the repos in the palette scope;
        // the repo picker is org/repo, empty = all visible repos the
        // backend greps. Scoped per-repo endpoint lives at
        // /api/<org>/<repo>/grep.
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q, mode: "literal", regex: isRegex }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          matches?: GrepMatch[];
          repo?: string;
          truncated?: boolean;
          error?: string;
        };
        if (!res.ok) throw new Error(data.error ?? `failed (${res.status})`);
        setMatches(data.matches ?? []);
        setMatchRepo(data.repo ?? null);
        setTruncated(Boolean(data.truncated));
        setResults(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="text-lg font-semibold">Code search</h1>
        <div className="flex gap-1 text-[13px]">
          <button
            className={`btn px-3 py-1 text-xs ${mode === "semantic" ? "btn-primary" : ""}`}
            onClick={() => { setMode("semantic"); setResults(null); setMatches(null); }}
          >semantic</button>
          <button
            className={`btn px-3 py-1 text-xs ${mode === "literal" ? "btn-primary" : ""}`}
            onClick={() => { setMode("literal"); setResults(null); setMatches(null); }}
          >literal / regex</button>
        </div>
      </div>
      <div className="flex gap-2 mb-5">
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder={mode === "semantic"
            ? "rate limiting logic, auth failure handling, webhook retries…"
            : isRegex ? "verifyTotp\\(|FORGE_SECRET" : "exact string, error code, function name…"}
        />
        <button className="btn btn-primary" onClick={run} disabled={busy || !q.trim()}>{busy ? "…" : "Search"}</button>
      </div>
      {mode === "literal" && (
        <label className="flex items-center gap-2 text-[13px] text-[var(--text-dim)] mb-4 cursor-pointer">
          <input type="checkbox" checked={isRegex} onChange={(e) => setIsRegex(e.target.checked)} className="accent-[var(--accent)]" />
          regular expression
          <span className="text-[var(--text-faint)] text-xs">· searches the current branch of the most recently updated repo scope</span>
        </label>
      )}

      {error && <div className="text-[13px] text-[var(--red)] mb-3">{error}</div>}

      {results !== null && results.length === 0 && matches === null && (
        <div className="card p-6 text-center text-[var(--text-dim)] text-[13px]">
          No matches. Repos need a push to be indexed.
        </div>
      )}
      {matches !== null && matches.length === 0 && (
        <div className="card p-6 text-center text-[var(--text-dim)] text-[13px]">
          No matches on the current branch.
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
        {matches?.map((m, i) => (
          <div key={i} className="card p-4">
            <div className="flex items-center gap-2 text-[13px] mb-1.5">
              <span className="mono">{m.path}</span>
              <span className="mono text-xs text-[var(--text-faint)]">:{m.line}</span>
              <span className="flex-1" />
              {matchRepo && <a href={`/${matchRepo}`} className="text-[var(--accent)] mono text-xs">{matchRepo}</a>}
            </div>
            <pre className="text-[12px] mono text-[var(--text-dim)] overflow-x-auto">{m.content}</pre>
          </div>
        ))}
      </div>
      {truncated && (
        <div className="mt-3 text-xs text-[var(--text-faint)]">Showing the first 200 matches — refine the pattern.</div>
      )}
    </div>
  );
}
