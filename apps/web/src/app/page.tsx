import { listRepos, recentActivity } from "@/server/api";
import { currentUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const user = await currentUser();
  const [repos, activity] = await Promise.all([listRepos(user?.id ?? null), recentActivity(15, user?.id ?? null)]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <section className="lg:col-span-2">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-lg font-semibold">Repositories</h1>
          <a href="/new" className="btn btn-primary">New repository</a>
        </div>
        {repos.length === 0 ? (
          <div className="card p-8 text-center text-[var(--text-dim)]">
            No repositories yet. Create one, then <code className="mono">git push</code> to it.
          </div>
        ) : (
          <div className="card divide-y">
            {repos.map((r) => (
              <a key={r.id} href={`/${r.orgSlug}/${r.name}`} className="block px-4 py-3 hover:bg-[var(--bg-hover)] transition-colors">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{r.orgSlug}/<span className="text-[var(--accent)]">{r.name}</span></span>
                  <span className="text-[10px] uppercase tracking-wide border border-[var(--border-strong)] rounded-full px-1.5 py-px text-[var(--text-faint)]">
                    {r.visibility}
                  </span>
                  <span className="flex-1" />
                  {r.openPrCount > 0 && (
                    <span className="text-xs text-[var(--purple)]">● {r.openPrCount} PR{r.openPrCount === 1 ? "" : "s"}</span>
                  )}
                  {r.openIntentCount > 0 && (
                    <span className="text-xs text-[var(--green)]">◍ {r.openIntentCount} intent{r.openIntentCount === 1 ? "" : "s"}</span>
                  )}
                </div>
                {r.description && <p className="text-[13px] text-[var(--text-dim)] mt-0.5">{r.description}</p>}
              </a>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-4">Activity</h2>
        <div className="card divide-y">
          {activity.length === 0 ? (
            <div className="p-4 text-[var(--text-dim)] text-[13px]">Nothing yet — push some code.</div>
          ) : (
            activity.map((a) => (
              <div key={a.id} className="px-4 py-2.5 text-[13px]">
                <span className="text-[var(--text-faint)] mono text-xs">{a.type}</span>
                <span className="ml-2">{typeof a.data?.title === "string" ? a.data.title : ""}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
