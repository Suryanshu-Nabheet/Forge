"use client";

// ⌘K command palette — global navigation.

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";

interface Action {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette({ repos }: { repos: Array<{ orgSlug: string; name: string }> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
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

  const actions: Action[] = [
    { id: "home", label: "Go to dashboard", hint: "/", run: () => router.push("/") },
    { id: "new", label: "Create new repository", hint: "/new", run: () => router.push("/new") },
    { id: "search", label: "Semantic search", hint: "/search", run: () => router.push("/search") },
    { id: "settings", label: "Settings (SSH keys, PATs)", hint: "/settings", run: () => router.push("/settings") },
    ...repos.flatMap((r) => {
      const slug = `${r.orgSlug}/${r.name}`;
      return [
        { id: `repo-${slug}`, label: `Open ${slug}`, hint: "repo", run: () => router.push(`/${slug}`) },
        { id: `pr-${slug}`, label: `Pull requests — ${slug}`, hint: "repo", run: () => router.push(`/${slug}/pulls`) },
        { id: `is-${slug}`, label: `Intents — ${slug}`, hint: "repo", run: () => router.push(`/${slug}/issues`) },
        { id: `ask-${slug}`, label: `Ask AI — ${slug}`, hint: "repo", run: () => router.push(`/${slug}/ask`) },
      ];
    }),
  ];

  const filtered = query
    ? actions.filter((a) => a.label.toLowerCase().includes(query.toLowerCase()))
    : actions.slice(0, 10);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, filtered.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    if (e.key === "Enter") {
      e.preventDefault();
      const a = filtered[cursor];
      if (a) { setOpen(false); a.run(); }
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" style={{ background: "rgba(0,0,0,0.5)" }} onClick={() => setOpen(false)}>
      <div className="card w-[560px] max-w-[92vw] overflow-hidden shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="w-full bg-transparent border-0 outline-none px-4 py-3 text-[14px] border-b"
          placeholder="Type a command or search…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
          onKeyDown={onKey}
        />
        <div className="max-h-[320px] overflow-y-auto">
          {filtered.length === 0 && <div className="px-4 py-6 text-center text-[13px] text-[var(--text-dim)]">No matches</div>}
          {filtered.map((a, i) => (
            <button
              key={a.id}
              className={`w-full text-left px-4 py-2.5 text-[13px] flex items-center ${i === cursor ? "bg-[var(--bg-hover)]" : ""}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => { setOpen(false); a.run(); }}
            >
              <span className="flex-1">{a.label}</span>
              {a.hint && <span className="mono text-[10px] text-[var(--text-faint)]">{a.hint}</span>}
            </button>
          ))}
        </div>
        <div className="border-t px-4 py-1.5 text-[11px] text-[var(--text-faint)] flex gap-3">
          <span>↑↓ navigate</span><span>↵ select</span><span>esc close</span>
        </div>
      </div>
    </div>
  );
}
