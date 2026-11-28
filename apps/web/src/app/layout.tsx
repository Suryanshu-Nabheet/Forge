import type { Metadata } from "next";
import "./globals.css";
import { CommandPalette } from "@/components/CommandPalette";
import { SignOutButton } from "@/components/SignOutButton";
import { currentUser } from "@/server/session";
import { listRepos } from "@/server/api";
import { countUnreadNotifications } from "@/server/api";

export const metadata: Metadata = {
  title: "Forge",
  description: "AI-native code collaboration",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let repos: Array<{ orgSlug: string; name: string }> = [];
  let userName: string | null = null;
  let unread = 0;
  let userId: number | null = null;
  try {
    const u = await currentUser();
    userName = u?.name ?? null;
    userId = u?.id ?? null;
  } catch { userName = null; }
  try {
    repos = (await listRepos(userId, 30)).map((r) => ({ orgSlug: r.orgSlug, name: r.name }));
  } catch { repos = []; } // palette degrades gracefully pre-migration
  try {
    if (userId !== null) unread = await countUnreadNotifications(userId);
  } catch { unread = 0; }
  return (
    <html lang="en" className="dark">
      <body>
        <CommandPalette repos={repos} />
        <div className="min-h-screen flex flex-col">
          <header className="border-b sticky top-0 z-40 backdrop-blur" style={{ background: "color-mix(in srgb, var(--bg) 85%, transparent)" }}>
            <nav className="max-w-6xl mx-auto px-4 h-12 flex items-center gap-5">
              <a href="/" className="font-bold tracking-tight flex items-center gap-2">
                <span className="text-base">⬡</span> FORGE
              </a>
              <a href="/" className="text-[13px] text-[var(--text-dim)] hover:text-[var(--text)]">Dashboard</a>
              <a href="/search" className="text-[13px] text-[var(--text-dim)] hover:text-[var(--text)]">Search</a>
              <a href="/new" className="text-[13px] text-[var(--text-dim)] hover:text-[var(--text)]">New</a>
              <a href="/notifications" className="text-[13px] text-[var(--text-dim)] hover:text-[var(--text)] flex items-center gap-1.5">
                Inbox
                {unread > 0 && (
                  <span className="bg-[var(--accent)] text-[var(--bg)] text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-4 text-center">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </a>
              <div className="flex-1" />
              <UserChip name={userName} />
            </nav>
          </header>
          <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-6">{children}</main>
          <footer className="border-t py-3 text-center text-xs text-[var(--text-faint)]">
            Forge — intent-first, AI-native code collaboration
          </footer>
        </div>
      </body>
    </html>
  );
}

function UserChip({ name }: { name: string | null }) {
  if (!name) {
    return (
      <a href="/login" className="text-[13px] text-[var(--text-dim)] hover:text-[var(--text)]">
        Sign in <span className="mono text-[11px] text-[var(--text-faint)] border border-dashed border-[var(--border-strong)] rounded px-1.5 py-0.5 ml-1">⌘K</span>
      </a>
    );
  }
  return <SignOutButton name={name} />;
}
