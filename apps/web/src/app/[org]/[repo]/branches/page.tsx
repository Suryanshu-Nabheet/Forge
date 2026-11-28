// /[org]/[repo]/branches — branch list with compare links and delete
// (member-gated via API; the page renders for anyone who can read).

import { findVisibleRepo, canWriteRepo } from "@/server/authz";
import { currentUser } from "@/server/session";
import { db, branches } from "@forge/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { DeleteBranchButton } from "@/components/DeleteBranchButton";

export const dynamic = "force-dynamic";

export default async function BranchesPage({ params }: { params: Promise<{ org: string; repo: string }> }) {
  const { org, repo } = await params;
  const info = await findVisibleRepo(org, repo);
  if (!info) return <div className="text-[var(--text-dim)]">not found</div>;
  const user = await currentUser();
  const canWrite = user ? await canWriteRepo(info.orgId, user.id) : false;

  const rows = await db
    .select({ name: branches.name, commitSha: branches.commitSha, isDefault: branches.isDefault, updatedAt: branches.updatedAt })
    .from(branches)
    .where(eq(branches.repoId, info.repoId))
    .orderBy(branches.name);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold">Branches</h1>
        <span className="text-xs text-[var(--text-faint)]">{rows.length} branch{rows.length === 1 ? "" : "es"}</span>
      </div>

      {rows.length === 0 ? (
        <div className="card p-8 text-center text-[var(--text-dim)] text-[13px]">No branches yet.</div>
      ) : (
        <div className="card divide-y">
          {rows.map((b) => (
            <div key={b.name} className="px-4 py-3 flex items-center gap-3 flex-wrap">
              <span className="mono text-[13px]">
                {b.isDefault && <span className="text-[var(--accent)] mr-1">●</span>}
                <Link href={`/${org}/${repo}?ref=${encodeURIComponent(b.name)}`}>{b.name}</Link>
              </span>
              <span className="mono text-xs text-[var(--text-faint)]">{b.commitSha.slice(0, 7)}</span>
              <span className="text-xs text-[var(--text-faint)]">{new Date(b.updatedAt).toLocaleString()}</span>
              <span className="flex-1" />
              {!b.isDefault && (
                <>
                  <Link href={`/${org}/${repo}/compare?range=${encodeURIComponent(`${info.defaultBranch}...${b.name}`)}`}
                    className="btn px-2 py-0.5 text-xs">Compare</Link>
                  {canWrite && <DeleteBranchButton org={org} repo={repo} branch={b.name} />}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
