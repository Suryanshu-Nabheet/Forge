import { findVisibleRepo } from "@/server/authz";
import { listBranchesDb, resolveBranchSha, repoCommits } from "@/server/api";
import { repoGitDir, listTags } from "@forge/git";
import Link from "next/link";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ org: string; repo: string }>;
  searchParams: Promise<{ ref?: string }>;
}

export default async function CommitsPage({ params, searchParams }: PageProps) {
  const { org, repo } = await params;
  const { ref: refParam } = await searchParams;
  const info = await findVisibleRepo(org, repo);
  if (!info) return <div className="text-[var(--text-dim)]">not found</div>;
  const gitDir = repoGitDir(org, repo);

  const branches = await listBranchesDb(info.repoId);
  const branch = refParam && branches.includes(refParam) ? refParam : info.defaultBranch;
  const sha = await resolveBranchSha(gitDir, branch, info.defaultBranch);
  const [commits, tags] = await Promise.all([
    sha ? repoCommits(gitDir, sha, 100) : [],
    listTags(gitDir),
  ]);
  const tagBySha = new Map(tags.map((t) => [t.sha, t.name]));

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="text-lg font-semibold">Commits</h1>
        <div className="flex items-center gap-3">
          <a href={`/${org}/${repo}/compare`} className="btn text-xs">Compare</a>
          <form action={`/${org}/${repo}/commits`} method="get" className="flex items-center gap-2">
            <select name="ref" defaultValue={branch} className="input text-xs" style={{ width: "auto" }}>
              {(branches.length ? branches : [branch]).map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
            <button className="btn text-xs" type="submit">Go</button>
          </form>
        </div>
      </div>

      {tags.length > 0 && (
        <div className="mb-4 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-[var(--text-faint)]">tags:</span>
          {tags.slice(0, 10).map((t) => (
            <span key={t.name} className="mono text-[11px] border border-[var(--border-strong)] rounded-full px-2 py-px text-[var(--text-dim)]">
              {t.name}
            </span>
          ))}
        </div>
      )}

      <div className="card divide-y">
        {commits.length === 0 && (
          <div className="px-4 py-8 text-center text-[var(--text-dim)] text-[13px]">No commits on this branch yet.</div>
        )}
        {commits.map((c) => {
          const tag = tagBySha.get(c.sha);
          return (
            <Link
              key={c.sha}
              href={`/${org}/${repo}/commits/${c.sha}`}
              className="block px-4 py-3 hover:bg-[var(--bg-hover)]"
            >
              <div className="flex items-baseline gap-3 flex-wrap">
                <span className="mono text-xs text-[var(--accent)] shrink-0">{c.sha.slice(0, 7)}</span>
                <span className="text-[13px] flex-1 truncate">{firstLine(c.message)}</span>
                {tag && (
                  <span className="text-[10px] uppercase border border-[var(--accent)] text-[var(--accent)] rounded-full px-1.5 py-px">
                    {tag}
                  </span>
                )}
              </div>
              <div className="text-xs text-[var(--text-faint)] mt-1">
                {c.authorName} · {timeAgo(c.authoredAt)}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

function timeAgo(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
