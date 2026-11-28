"use client";

import { useEffect, useState } from "react";

interface Notification {
  id: number;
  type: string;
  repo: string;
  actor: string | null;
  createdAt: string | null;
  unread: boolean;
  data: Record<string, unknown>;
}

const TYPE_LABELS: Record<string, string> = {
  pr_opened: "opened a pull request",
  pr_merged: "merged a pull request",
  pr_closed: "closed a pull request",
  pr_reopened: "reopened a pull request",
  pr_approved: "approved a pull request",
  release_published: "published a release",
  pr_changes_requested: "requested changes on a pull request",
  review_requested: "requested a review",
  intent_created: "created an intent",
  intent_scaffolded: "scaffolded a branch for an intent",
  intent_closed: "closed an intent",
  intent_reopened: "reopened an intent",
};

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [needsReview, setNeedsReview] = useState<Array<{ repo: string; number: number; title: string; source: string }>>([]);
  const [unread, setUnread] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [marking, setMarking] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/notifications");
        if (res.ok) {
          const data = (await res.json()) as {
            notifications: Notification[];
            unread: number;
            needsReview?: Array<{ repo: string; number: number; title: string; source: string }>;
          };
          setNotifications(data.notifications);
          setNeedsReview(data.needsReview ?? []);
          setUnread(data.unread);
        }
      } catch { /* leave empty state */ }
      setLoaded(true);
    })();
  }, []);

  async function markAllRead() {
    setMarking(true);
    try {
      await fetch("/api/notifications", { method: "POST" });
      setUnread(0);
      setNotifications((prev) => prev.map((n) => ({ ...n, unread: false })));
    } catch { /* badge refreshes next load */ }
    finally { setMarking(false); }
  }

  function hrefFor(n: Notification): string {
    const num = (n.data as { number?: number }).number;
    if (n.type.startsWith("pr_") && typeof num === "number") return `/${n.repo}/pulls/${num}`;
    if (/^intent/.test(n.type) && typeof num === "number") return `/${n.repo}/issues/${num}`;
    if (n.type === "release_published") {
      const tag = (n.data as { tag?: string }).tag;
      return tag ? `/${n.repo}/releases` : `/${n.repo}`;
    }
    return `/${n.repo}`;
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold">Inbox</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-[var(--text-faint)]">{unread} unread</span>
          {unread > 0 && (
            <button className="btn px-2 py-1 text-xs" disabled={marking} onClick={markAllRead}>
              {marking ? "Marking…" : "Mark all read"}
            </button>
          )}
        </div>
      </div>
      {needsReview.length > 0 && (
        <div className="card divide-y mb-4">
          <div className="px-4 py-2 text-[11px] uppercase tracking-wide text-[var(--text-faint)]">
            needs your review ({needsReview.length})
          </div>
          {needsReview.map((q) => (
            <a key={`${q.repo}-${q.number}`} href={`/${q.repo}/pulls/${q.number}`}
              className="block px-4 py-2.5 hover:bg-[var(--bg-hover)]">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-[13px] font-medium">{q.title}</span>
                <span className="text-xs text-[var(--text-faint)]">#{q.number}</span>
                {q.source === "codeowners" && (
                  <span className="text-[10px] text-[var(--text-faint)]" title="assigned via CODEOWNERS">⚙</span>
                )}
                <span className="flex-1" />
                <span className="mono text-xs text-[var(--text-faint)]">{q.repo}</span>
              </div>
            </a>
          ))}
        </div>
      )}
      <div className="card divide-y">
        {!loaded && <div className="px-4 py-8 text-center text-[13px] text-[var(--text-dim)]">loading…</div>}
        {loaded && notifications.length === 0 && (
          <div className="px-4 py-8 text-center text-[13px] text-[var(--text-dim)]">
            Nothing here yet. Activity from your organizations will show up in this feed.
          </div>
        )}
        {notifications.map((n) => (
          <a key={n.id} href={hrefFor(n)} className="block px-4 py-3 hover:bg-[var(--bg-hover)]">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className={`text-[13px] ${n.unread ? "font-semibold" : "text-[var(--text-dim)]"}`}>
                {n.actor ?? "someone"}{" "}
                <span className="text-[var(--text-dim)]">{TYPE_LABELS[n.type] ?? n.type}</span>
              </span>
              {n.unread && <span className="w-2 h-2 rounded-full bg-[var(--accent)]" />}
              <span className="flex-1" />
              <span className="mono text-xs text-[var(--text-faint)]">{n.repo}</span>
            </div>
            {"title" in n.data && (
              <div className="text-xs text-[var(--text-faint)] mt-0.5 truncate">
                {String((n.data as { title?: string }).title)}
              </div>
            )}
            <div className="text-[11px] text-[var(--text-faint)] mt-0.5">{timeAgo(n.createdAt)}</div>
          </a>
        ))}
      </div>
    </div>
  );
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
