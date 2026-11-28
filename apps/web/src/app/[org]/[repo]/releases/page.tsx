// /[org]/[repo]/releases — tag-based releases with Markdown notes.

import { findVisibleRepo } from "@/server/authz";
import { db, releases } from "@forge/db";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { Markdown } from "@/components/Markdown";

export const dynamic = "force-dynamic";

export default async function ReleasesPage({ params }: { params: Promise<{ org: string; repo: string }> }) {
  const { org, repo } = await params;
  const info = await findVisibleRepo(org, repo);
  if (!info) return <div className="text-[var(--text-dim)]">not found</div>;

  const rows = await db
    .select()
    .from(releases)
    .where(eq(releases.repoId, info.repoId))
    .orderBy(desc(releases.id))
    .limit(30);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold">Releases</h1>
        <Link href={`/${org}/${repo}/releases/new`} className="btn btn-primary text-xs">New release</Link>
      </div>

      {rows.length === 0 ? (
        <div className="card p-8 text-center text-[var(--text-dim)] text-[13px]">
          No releases yet — tag a commit to publish one.
        </div>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => (
            <div key={r.id} className="card p-4">
              <div className="flex items-baseline gap-3 flex-wrap">
                <span className="font-semibold">{r.name}</span>
                <span className="mono text-xs text-[var(--accent)]">{r.tagName}</span>
                {r.isPrerelease && <span className="text-[10px] uppercase border border-[var(--yellow)] text-[var(--yellow)] rounded-full px-1.5 py-px">pre-release</span>}
                <span className="flex-1" />
                <Link href={`/${org}/${repo}/commits/${r.targetSha}`}
                  className="mono text-xs text-[var(--text-faint)] hover:text-[var(--accent)]">
                  {r.targetSha.slice(0, 7)}
                </Link>
                <span className="text-xs text-[var(--text-faint)]">{new Date(r.createdAt).toLocaleDateString()}</span>
              </div>
              {r.notes && (
                <div className="mt-3 text-[13px] leading-relaxed">
                  <Markdown text={r.notes} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
