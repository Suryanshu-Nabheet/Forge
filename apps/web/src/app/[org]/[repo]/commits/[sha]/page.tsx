import { findVisibleRepo } from "@/server/authz";
import { repoGitDir } from "@forge/git";
import { commitInfo, diffCommit, commitStats } from "@forge/git";
import { Markdown } from "@/components/Markdown";

export const dynamic = "force-dynamic";

const SHA_RE = /^[0-9a-f]{4,40}$/i;

export default async function CommitPage({ params }: { params: Promise<{ org: string; repo: string; sha: string }> }) {
  const { org, repo, sha } = await params;
  const info = await findVisibleRepo(org, repo);
  if (!info) return <div className="text-[var(--text-dim)]">not found</div>;
  if (!SHA_RE.test(sha)) return <div className="text-[var(--text-dim)]">invalid commit id</div>;

  const gitDir = repoGitDir(org, repo);
  const commit = await commitInfo(gitDir, sha);
  if (!commit) return <div className="text-[var(--text-dim)]">commit not found: {sha}</div>;

  const [diff, stats] = await Promise.all([
    diffCommit(gitDir, commit.sha).catch(() => []),
    commitStats(gitDir, commit.sha),
  ]);
  const totalAdd = diff.reduce((n, f) => n + f.additions, 0);
  const totalDel = diff.reduce((n, f) => n + f.deletions, 0);

  return (
    <div>
      <div className="flex items-baseline gap-3 flex-wrap mb-1">
        <h1 className="text-lg font-semibold">{firstLine(commit.message)}</h1>
        <span className="mono text-xs text-[var(--text-faint)]">{commit.sha.slice(0, 7)}</span>
      </div>
      <div className="text-[13px] text-[var(--text-dim)] mb-4">
        {commit.authorName} &lt;{commit.authorEmail}&gt; · {new Date(commit.authoredAt).toLocaleString()} ·{" "}
        <span className="text-[var(--green)]">+{totalAdd || stats.additions}</span>{" "}
        <span className="text-[var(--red)]">−{totalDel || stats.deletions}</span>
        {commit.parentShas.length > 0 && (
          <> · parent{" "}
            {commit.parentShas.map((p) => (
              <a key={p} href={`/${org}/${repo}/commits/${p}`} className="mono text-xs text-[var(--accent)] mr-1">{p.slice(0, 7)}</a>
            ))}
          </>
        )}
      </div>

      {commit.message.includes("\n") && (
        <div className="card p-4 mb-4">
          <Markdown text={commit.message.split("\n").slice(1).join("\n").trim()} className="text-[13px]" />
        </div>
      )}

      <div className="space-y-4">
        {diff.length === 0 && (
          <div className="card p-6 text-center text-[var(--text-dim)] text-[13px]">
            No changes (root commit, merge, or diff unavailable).
          </div>
        )}
        {diff.map((f) => (
          <div key={f.path} className="card overflow-hidden">
            <div className="px-4 py-2 border-b flex items-center gap-2 text-[13px]">
              <span className="mono">{f.path}</span>
              <span className="text-xs text-[var(--green)]">+{f.additions}</span>
              <span className="text-xs text-[var(--red)]">−{f.deletions}</span>
              <span className="flex-1" />
              <span className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">{f.status}</span>
            </div>
            {f.isBinary ? (
              <div className="px-4 py-6 text-center text-[var(--text-dim)] text-[13px]">Binary file</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px] mono" style={{ borderCollapse: "collapse" }}>
                  <tbody>
                    {f.hunks.map((h, hi) => (
                      <HunkRows key={hi} hunk={h} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function HunkRows({ hunk }: { hunk: import("@forge/shared").DiffHunk }) {
  return (
    <>
      <tr>
        <td colSpan={3} className="px-4 py-1 text-[11px] text-[var(--text-faint)] bg-[var(--bg-hover)] mono border-y">
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
        </td>
      </tr>
      {hunk.lines.map((l, li) => {
        const bg = l.type === "add" ? "color-mix(in srgb, var(--green) 10%, var(--bg))" : l.type === "remove" ? "color-mix(in srgb, var(--red) 10%, var(--bg))" : "transparent";
        const marker = l.type === "add" ? "+" : l.type === "remove" ? "−" : " ";
        return (
          <tr key={li} style={{ background: bg }}>
            <td className="pl-4 pr-2 text-[var(--text-faint)] select-none w-10 text-right align-top">{l.oldLine ?? ""}</td>
            <td className="px-1 text-[var(--text-faint)] select-none w-10 text-right align-top border-r">{l.newLine ?? ""}</td>
            <td className="pl-3 pr-4 whitespace-pre-wrap break-all" style={{ width: "99%" }}>
              <span className={l.type === "add" ? "text-[var(--green)]" : l.type === "remove" ? "text-[var(--red)]" : ""}>{marker} </span>
              {l.content}
            </td>
          </tr>
        );
      })}
    </>
  );
}

function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}
