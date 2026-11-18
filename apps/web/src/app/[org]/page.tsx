// /org — organization landing: its repositories.

import { eq } from "drizzle-orm";
import { db, organizations, repositories } from "@forge/db";
import { desc, sql } from "drizzle-orm";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function OrgPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: orgSlug } = await params;
  const orgRows = await db.select().from(organizations).where(eq(organizations.slug, orgSlug)).limit(1);
  const org = orgRows[0];
  if (!org) {
    return <div className="p-8 text-center text-[var(--text-dim)]">Organization not found: {orgSlug}</div>;
  }

  const repos = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      description: repositories.description,
      visibility: repositories.visibility,
      updatedAt: repositories.updatedAt,
      openPrCount: sql<number>`(SELECT count(*) FROM pull_requests pr WHERE pr.repo_id = ${repositories.id} AND pr.status = 'open')`,
    })
    .from(repositories)
    .where(eq(repositories.orgId, org.id))
    .orderBy(desc(repositories.updatedAt));

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-lg font-semibold">{org.name}</h1>
        <p className="text-[13px] text-[var(--text-dim)]">
          <span className="mono">{org.slug}</span> · {repos.length} repositor{repos.length === 1 ? "y" : "ies"}
        </p>
      </div>
      {repos.length === 0 ? (
        <div className="card p-8 text-center text-[var(--text-dim)] text-[13px]">
          No repositories in this org yet. <Link className="text-[var(--accent)]" href="/new">Create one</Link>.
        </div>
      ) : (
        <div className="card divide-y">
          {repos.map((r) => (
            <Link key={r.id} href={`/${orgSlug}/${r.name}`} className="block px-4 py-3 hover:bg-[var(--bg-hover)]">
              <div className="flex items-baseline gap-2">
                <span className="font-medium">{r.name}</span>
                <span className="text-[10px] uppercase tracking-wide border border-[var(--border-strong)] rounded-full px-1.5 py-px text-[var(--text-faint)]">
                  {r.visibility}
                </span>
                <span className="flex-1" />
                {Number(r.openPrCount) > 0 && (
                  <span className="text-xs text-[var(--purple)]">● {Number(r.openPrCount)} PR{Number(r.openPrCount) === 1 ? "" : "s"}</span>
                )}
              </div>
              {r.description && <p className="text-[13px] text-[var(--text-dim)] mt-0.5">{r.description}</p>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
