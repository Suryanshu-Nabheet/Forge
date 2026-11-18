import { findVisibleRepo } from "@/server/authz";
import { listIntents } from "@/server/api";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  open: "text-[var(--green)]",
  in_progress: "text-[var(--yellow)]",
  in_review: "text-[var(--purple)]",
  merge_ready: "text-[var(--accent)]",
  done: "text-[var(--text-faint)]",
  closed: "text-[var(--text-faint)]",
};

export default async function IssuesPage({ params }: { params: Promise<{ org: string; repo: string }> }) {
  const { org, repo } = await params;
  const info = await findVisibleRepo(org, repo);
  if (!info) return <div className="text-[var(--text-dim)]">not found</div>;
  const intents = await listIntents(info.repoId);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold">Intents & issues</h1>
        <a href={`/${org}/${repo}/issues/new`} className="btn btn-primary">New intent</a>
      </div>
      <div className="card divide-y">
        {intents.length === 0 && (
          <div className="px-4 py-8 text-center text-[var(--text-dim)] text-[13px]">
            No intents yet. Intents are specs linked to code — create one, draft a plan, push a branch.
          </div>
        )}
        {intents.map((i) => (
          <a key={i.id} href={`/${org}/${repo}/issues/${i.number}`} className="block px-4 py-3 hover:bg-[var(--bg-hover)]">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-xs mono text-[var(--text-faint)]">#{i.number}</span>
              <span className={`font-medium ${i.status === "done" || i.status === "closed" ? "line-through text-[var(--text-dim)]" : ""}`}>
                {i.title}
              </span>
              <span className={`text-xs ${STATUS_STYLE[i.status] ?? ""}`}>● {i.status}</span>
              {i.hasPlan && <span className="text-xs text-[var(--accent)]">✦ has plan</span>}
              {i.branchName && <span className="text-xs mono text-[var(--text-dim)]">{i.branchName}</span>}
              <span className="flex-1" />
              {i.labels.map((l) => (
                <span key={l} className="text-[10px] border border-[var(--border-strong)] rounded-full px-2 py-px text-[var(--text-dim)]">{l}</span>
              ))}
            </div>
            <div className="text-xs text-[var(--text-faint)] mt-1">by {i.authorHandle} · {i.kind}</div>
          </a>
        ))}
      </div>
    </div>
  );
}
