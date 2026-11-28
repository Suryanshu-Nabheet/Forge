// /u/[handle] — public profile: repos they own (orgs they own), recent
// activity across those orgs, joined date. Private repos stay hidden
// unless the viewer can read them.

import { desc, eq, or } from "drizzle-orm";
import { db, users, organizations, repositories, activities } from "@forge/db";
import { currentUser } from "@/server/session";
import { canReadRepo } from "@/server/authz";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ProfilePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const userRow = (await db
    .select({ id: users.id, name: users.name, handle: users.handle, avatarUrl: users.avatarUrl, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.handle, handle))
    .limit(1))[0];
  if (!userRow) {
    return <div className="p-8 text-center text-[var(--text-dim)]">No such user: {handle}</div>;
  }

  // Orgs where this user is owner, plus orgs they're a member of.
  const viewer = await currentUser();
  const orgs = await db
    .select({ id: organizations.id, slug: organizations.slug, name: organizations.name, ownerId: organizations.ownerId })
    .from(organizations)
    .where(or(eq(organizations.ownerId, userRow.id), eq(organizations.slug, userRow.handle)))
    .limit(20);

  // Repos in those orgs, visibility-filtered for the viewer.
  const repoRows = orgs.length
    ? await db
        .select({
          orgSlug: organizations.slug,
          name: repositories.name,
          description: repositories.description,
          visibility: repositories.visibility,
          updatedAt: repositories.updatedAt,
          orgId: repositories.orgId,
          id: repositories.id,
        })
        .from(repositories)
        .innerJoin(organizations, eq(organizations.id, repositories.orgId))
        .where(or(...orgs.map((o) => eq(repositories.orgId, o.id))))
        .orderBy(desc(repositories.updatedAt))
        .limit(50)
    : [];

  const visibleRepos = [];
  for (const r of repoRows) {
    if (r.visibility === "public" || (viewer && await canReadRepo(r.id, r.orgId, r.visibility, viewer.id))) {
      visibleRepos.push(r);
    }
  }

  // Recent activity by this user across readable repos.
  const act = await db
    .select({ id: activities.id, repoId: activities.repoId, type: activities.type, data: activities.data, createdAt: activities.createdAt })
    .from(activities)
    .where(eq(activities.userId, userRow.id))
    .orderBy(desc(activities.id))
    .limit(20);
  const repoNameById = new Map(visibleRepos.map((r) => [r.id, `${r.orgSlug}/${r.name}`]));
  const actVisible = act.filter((a) => a.repoId !== null && repoNameById.has(a.repoId));

  return (
    <div className="max-w-3xl">
      <div className="flex items-center gap-4 mb-6">
        <div className="w-16 h-16 rounded-full bg-[var(--accent)]/15 border flex items-center justify-center text-2xl">
          {userRow.name.slice(0, 1).toUpperCase()}
        </div>
        <div>
          <h1 className="text-lg font-semibold">{userRow.name}</h1>
          <div className="text-[13px] text-[var(--text-dim)] mono">@{userRow.handle}</div>
          <div className="text-xs text-[var(--text-faint)]">joined {new Date(userRow.createdAt).toLocaleDateString()}</div>
        </div>
      </div>

      <h2 className="text-base font-semibold mb-2">Repositories</h2>
      {visibleRepos.length === 0 ? (
        <div className="card p-6 text-center text-[var(--text-dim)] text-[13px] mb-6">No visible repositories.</div>
      ) : (
        <div className="card divide-y mb-6">
          {visibleRepos.map((r) => (
            <Link key={r.id} href={`/${r.orgSlug}/${r.name}`} className="block px-4 py-3 hover:bg-[var(--bg-hover)]">
              <div className="flex items-baseline gap-2">
                <span className="font-medium">{r.orgSlug}/<span className="text-[var(--accent)]">{r.name}</span></span>
                <span className="text-[10px] uppercase border border-[var(--border-strong)] rounded-full px-1.5 py-px text-[var(--text-faint)]">{r.visibility}</span>
                <span className="flex-1" />
                <span className="text-xs text-[var(--text-faint)]">{new Date(r.updatedAt).toLocaleDateString()}</span>
              </div>
              {r.description && <div className="text-[13px] text-[var(--text-dim)] mt-0.5">{r.description}</div>}
            </Link>
          ))}
        </div>
      )}

      <h2 className="text-base font-semibold mb-2">Activity</h2>
      {actVisible.length === 0 ? (
        <div className="card p-6 text-center text-[var(--text-dim)] text-[13px]">No recent activity.</div>
      ) : (
        <div className="card divide-y">
          {actVisible.map((a) => (
            <div key={a.id} className="px-4 py-2.5 text-[13px]">
              <span className="text-[var(--text-faint)] mono text-xs">{a.type}</span>
              <span className="mx-2">{typeof (a.data as { title?: string }).title === "string" ? (a.data as { title?: string }).title : ""}</span>
              <span className="text-xs text-[var(--text-faint)]">· {a.repoId !== null ? repoNameById.get(a.repoId) : ""}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
