"use client";

// Live build-log viewer for a PR: SSE stream from /api/sse/pr-<number>,
// seeded with the initial events rendered server-side.

import { useEffect, useRef, useState } from "react";

export interface LogEvent {
  id: number;
  level: "info" | "warn" | "error";
  message: string;
}

export function LiveLogs({ org, repo, prNumber, initial }: {
  org: string; repo: string; prNumber: number; initial: LogEvent[];
}) {
  const [events, setEvents] = useState<LogEvent[]>(initial);
  const [live, setLive] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`/api/sse/${org}/${repo}/pr-${prNumber}`);
    es.addEventListener("open", () => setLive(true));
    es.addEventListener("log", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { level: LogEvent["level"]; message: string };
        setEvents((prev) => [...prev.slice(-200), { id: Date.now() + Math.random(), level: data.level, message: data.message }]);
      } catch { /* malformed frame */ }
    });
    es.addEventListener("tick", () => setLive(true));
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [org, repo, prNumber]);

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [events]);

  if (events.length === 0) {
    return (
      <div className="mt-3 text-[12px] text-[var(--text-faint)] mono">
        No build logs yet — they stream here while the sandbox runs.
      </div>
    );
  }

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 mb-1.5 text-[11px] text-[var(--text-faint)]">
        <span className={live ? "text-[var(--green)]" : ""}>{live ? "● live" : "○ offline"}</span>
        <span>build + job logs</span>
      </div>
      <div ref={boxRef} className="max-h-48 overflow-auto rounded p-3 border mono text-[11.5px] leading-relaxed bg-[var(--bg)]">
        {events.map((e) => (
          <div key={e.id} className={e.level === "error" ? "text-[var(--red)]" : e.level === "warn" ? "text-[var(--yellow)]" : ""}>
            {e.message}
          </div>
        ))}
      </div>
    </div>
  );
}
