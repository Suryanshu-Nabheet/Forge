"use client";

// ⌘K command palette — global fuzzy navigation.
// Scoring: subsequence match with bonuses for word-boundary starts,
// consecutive runs, and prefix hits (ripgrep-flavored fuzzy). Results
// group by kind; empty query shows recently-visited items.

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";

interface Action {
  id: string;
  label: string;
  group: "Navigate" | "Create" | "Repository" | "Repos & pages";
  hint?: string;
  keywords?: string;
  run: () => void;
}

/** Fuzzy subsequence score; 0 = no match. Higher is better. */
function fuzzyScore(needle: string, haystack: string): number {
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (!n) return 1;
  let score = 0;
  let hi = 0;
  let run = 0;
  for (const ch of n) {
    const found = h.indexOf(ch, hi);
    if (found === -1) return 0;
    // Word-boundary / start bonuses.
    if (found === 0 || /[\s/\-_./]/.test(h[found - 1] ?? "")) score += 8;
    // Consecutive-run bonus.
    if (found === hi && hi > 0) run += 1;
    else run = 0;
    score += 4 - Math.min(3, found - hi); // proximity
    score += run * 2;
    hi = found + 1;
  }
  return score;
}

export function CommandPalette({ repos }: { repos: Array<{ orgSlug: string; name: string }> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      } else if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        // GitHub-style "/" focuses the palette for quick nav.
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  // Scroll the highlighted row into view.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const actions: Action[] = [
    { id: "home", label: "Go to dashboard", group: "Navigate", hint: "/", run: () => router.push("/") },
    { id: "new", label: "Create new repository", group: "Create", hint: "/new", run: () => router.push("/new") },
    { id: "search", label: "Semantic & literal code search", group: "Navigate", hint: "/search", keywords: "grep regex", run: () => router.push("/search") },
    { id: "settings", label: "Settings — SSH keys, PATs, 2FA", group: "Navigate", hint: "/settings", run: () => router.push("/settings") },
    { id: "inbox", label: "Inbox — notifications & review queue", group: "Navigate", hint: "/notifications", keywords: "review requests", run: () => router.push("/notifications") },
    ...repos.flatMap((r) => {
      const slug = `${r.orgSlug}/${r.name}`;
      return [
        { id: `repo-${slug}`, label: slug, group: "Repository" as const, hint: "code", run: () => router.push(`/${slug}`) },
        { id: `pr-${slug}`, label: `Pull requests — ${slug}`, group: "Repository" as const, keywords: "pr", run: () => router.push(`/${slug}/pulls`) },
        { id: `is-${slug}`, label: `Intents — ${slug}`, group: "Repository" as const, keywords: "issues", run: () => router.push(`/${slug}/issues`) },
        { id: `br-${slug}`, label: `Branches — ${slug}`, group: "Repository" as const, run: () => router.push(`/${slug}/branches`) },
        { id: `rel-${slug}`, label: `Releases — ${slug}`, group: "Repository" as const, run: () => router.push(`/${slug}/releases`) },
        { id: `ask-${slug}`, label: `Ask AI — ${slug}`, group: "Repository" as const, run: () => router.push(`/${slug}/ask`) },
      ];
    }),
  ];

  const scored = query
    ? actions
        .map((a) => ({ a, s: Math.max(fuzzyScore(query, a.label), a.keywords ? fuzzyScore(query, a.keywords) : 0) }))
        .filter((x) => x.s > 0)
        .sort((x, y) => y.s - x.s)
        .slice(0, 30)
        .map((x) => x.a)
    : actions.slice(0, 12);

  // Group consecutive items by their group for section headers.
  const rows: Array<{ type: "header"; group: Action["group"] } | { type: "item"; action: Action; idx: number }> = [];
  let lastGroup: Action["group"] | null = null;
  let idx = 0;
  for (const a of scored) {
    if (a.group !== lastGroup) {
      rows.push({ type: "header", group: a.group });
      lastGroup = a.group;
    }
    rows.push({ type: "item", action: a, idx });
    idx++;
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, scored.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    if (e.key === "Enter") {
      e.preventDefault();
      const a = scored[cursor];
      if (a) { close(); a.run(); }
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" style={{ background: "rgba(0,0,0,0.55)" }} onClick={close}>
      <div className="card w-[560px] max-w-[92vw] overflow-hidden shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="w-full bg-transparent border-0 outline-none px-4 py-3 text-[14px] border-b"
          placeholder="Jump to… (repos, pulls, intents, releases, ask)"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
          onKeyDown={onKey}
        />
        <div className="max-h-[340px] overflow-y-auto" ref={listRef}>
          {scored.length === 0 && <div className="px-4 py-6 text-center text-[13px] text-[var(--text-dim)]">No matches</div>}
          {rows.map((row, i) =>
            row.type === "header" ? (
              <div key={`h-${i}`} className="px-4 pt-2.5 pb-1 text-[10px] uppercase tracking-wide text-[var(--text-faint)]">
                {row.group}
              </div>
            ) : (
              <button
                key={row.action.id}
                data-idx={row.idx}
                className={`w-full text-left px-4 py-2 text-[13px] flex items-center ${row.idx === cursor ? "bg-[var(--bg-hover)]" : ""}`}
                onMouseEnter={() => setCursor(row.idx)}
                onClick={() => { close(); row.action.run(); }}
              >
                <span className="flex-1">{row.action.label}</span>
                {row.action.hint && <span className="mono text-[10px] text-[var(--text-faint)]">{row.action.hint}</span>}
              </button>
            ),
          )}
        </div>
        <div className="border-t px-4 py-1.5 text-[11px] text-[var(--text-faint)] flex gap-3 flex-wrap">
          <span>↑↓ navigate</span><span>↵ select</span><span>esc close</span><span>/ opens</span>
        </div>
      </div>
    </div>
  );
}
