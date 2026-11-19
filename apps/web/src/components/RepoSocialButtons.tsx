"use client";

import { useState } from "react";

interface Social {
  stars: number;
  watchers: number;
  forks: number;
  starred: boolean;
  watching: boolean;
}

/** Star / Watch / Fork buttons on the repo header. Optimistic UI. */
export function RepoSocialButtons({ org, repo, social, signedIn, forkedFrom }: {
  org: string;
  repo: string;
  social: Social;
  signedIn: boolean;
  forkedFrom: string | null;
}) {
  const [state, setState] = useState(social);
  const [busy, setBusy] = useState<"" | "star" | "watch" | "fork">("");
  const [error, setError] = useState<string | null>(null);

  async function toggle(kind: "star" | "watch") {
    if (!signedIn) {
      window.location.href = "/login";
      return;
    }
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch(`/api/${org}/${repo}/${kind}`, { method: "POST" });
      const data = (await res.json()) as { starred?: boolean; watching?: boolean; stars?: number; watchers?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `failed (${res.status})`);
      setState((s) => ({
        ...s,
        starred: data.starred ?? s.starred,
        watching: data.watching ?? s.watching,
        stars: data.stars ?? s.stars,
        watchers: data.watchers ?? s.watchers,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function fork() {
    if (!signedIn) {
      window.location.href = "/login";
      return;
    }
    setBusy("fork");
    setError(null);
    try {
      const res = await fetch(`/api/${org}/${repo}/fork`, { method: "POST" });
      const data = (await res.json()) as { orgSlug?: string; name?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `failed (${res.status})`);
      window.location.href = `/${data.orgSlug ?? org}/${data.name ?? repo}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy("");
    }
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-[var(--red)]">{error}</span>}
      <button
        className="btn text-xs flex items-center gap-1.5"
        disabled={busy !== ""}
        onClick={() => void toggle("star")}
        title={state.starred ? "Unstar" : "Star"}
      >
        <span>{state.starred ? "★" : "☆"}</span>
        {state.starred ? "Starred" : "Star"}
        <span className="mono text-[10px] text-[var(--text-faint)] border border-[var(--border-strong)] rounded-full px-1.5">
          {state.stars}
        </span>
      </button>
      <button
        className="btn text-xs flex items-center gap-1.5"
        disabled={busy !== ""}
        onClick={() => void toggle("watch")}
        title={state.watching ? "Unwatch" : "Watch"}
      >
        <span>{state.watching ? "👁" : "👁"}</span>
        {state.watching ? "Watching" : "Watch"}
        <span className="mono text-[10px] text-[var(--text-faint)] border border-[var(--border-strong)] rounded-full px-1.5">
          {state.watchers}
        </span>
      </button>
      <button
        className="btn text-xs flex items-center gap-1.5"
        disabled={busy !== "" || forkedFrom !== null}
        onClick={() => void fork()}
        title={forkedFrom ? "This repo is a fork" : "Fork this repository"}
      >
        <span>⑂</span>
        Fork
        <span className="mono text-[10px] text-[var(--text-faint)] border border-[var(--border-strong)] rounded-full px-1.5">
          {state.forks}
        </span>
      </button>
    </div>
  );
}
