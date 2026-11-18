import { findRepo, listPrs } from "@/server/api";
import { prRiskColor } from "@/components/risk";

export const dynamic = "force-dynamic";

export default async function PullsPage({ params }: { params: Promise<{ org: string; repo: string }> }) {
  const { org, repo } = await params;
  const info = await findRepo(org, repo);
  if (!info) return <div className="text-[var(--text-dim)]">not found</div>;
  const prs = await listPrs(info.id);
  const open = prs.filter((p) => p.status === "open");
  const closed = prs.filter((p) => p.status !== "open");

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold">Pull requests</h1>
        <span className="text-xs text-[var(--text-faint)]">{open.length} open</span>
      </div>
      <div className="card divide-y">
        {prs.length === 0 && (
          <div className="px-4 py-8 text-center text-[var(--text-dim)] text-[13px]">
            No pull requests. Push a branch named <code className="mono">i&lt;n&gt;-description</code> to auto-open one from intent #n.
          </div>
        )}
        {[...open, ...closed].map((p) => (
          <a key={p.id} href={`/${org}/${repo}/pulls/${p.number}`} className="block px-4 py-3 hover:bg-[var(--bg-hover)]">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="font-medium">{p.title}</span>
              <span className="text-xs text-[var(--text-faint)]">#{p.number}</span>
              {p.status === "open" ? (
                <span className="text-xs text-[var(--purple)]">● open</span>
              ) : p.status === "merged" ? (
                <span className="text-xs text-[var(--purple)]">✓ merged</span>
              ) : (
                <span className="text-xs text-[var(--text-faint)]">✕ closed</span>
              )}
              <span className="flex-1" />
              {p.riskScore !== null && (
                <span className={`text-xs mono ${prRiskColor(p.riskScore)}`}>risk {Math.round(p.riskScore)}</span>
              )}
              <span className="text-xs text-[var(--text-dim)] mono">{p.headBranch} → {p.baseBranch}</span>
            </div>
            <div className="text-xs text-[var(--text-faint)] mt-1">
              by {p.authorName} · {timeAgo(p.createdAt)}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
