import { findVisibleRepo } from "@/server/authz";
import { listBranchesDb } from "@/server/api";
import { repoGitDir, revParse, diffRevs, revListCommits, isAncestor } from "@forge/git";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ org: string; repo: string }>;
  searchParams: Promise<{ base?: string; head?: string }>;
}

export default async function ComparePage({ params, searchParams }: PageProps) {
  const { org, repo } = await params;
  const { base: baseParam, head: headParam } = await searchParams;
  const info = await findVisibleRepo(org, repo);
  if (!info) return <div className="text-[var(--text-dim)]">not found</div>;
  const gitDir = repoGitDir(org, repo);

  const branches = await listBranchesDb(info.repoId);
  const base = baseParam && branches.includes(baseParam) ? baseParam : info.defaultBranch;
  const head = headParam && branches.includes(headParam) ? headParam : branches.find((b) => b !== base) ?? base;

  const baseSha = await revParse(gitDir, base);
  const headSha = await revParse(gitDir, head);
  const valid = baseSha !== null && headSha !== null && base !== head;

  const [diff, commits, ahead] = valid
    ? await Promise.all([
        diffRevs(gitDir, base, head).catch(() => []),
        revListCommits(gitDir, `${base}...${head}`, 200).catch(() => []),
        isAncestor(gitDir, base, head),
      ])
    : [[], [], false];

  const totalAdd = diff.reduce((n, f) => n + f.additions, 0);
  const totalDel = diff.reduce((n, f) => n + f.deletions, 0);
  const conflict = valid && !ahead; // head has diverged from base

  return (
    <div>
      <h1 className="text-lg font-semibold mb-4">Compare</h1>

      <form action={`/${org}/${repo}/compare`} method="get" className="card p-4 mb-4 flex items-end gap-3 flex-wrap">
        <div>
          <label className="text-[12px] text-[var(--text-dim)] block mb-1">base</label>
          <select name="base" defaultValue={base} className="input text-xs" style={{ width: "auto" }}>
            {branches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <span className="pb-2 text-[var(--text-faint)]">…</span>
        <div>
          <label className="text-[12px] text-[var(--text-dim)] block mb-1">compare</label>
          <select name="head" defaultValue={head} className="input text-xs" style={{ width: "auto" }}>
            {branches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <button className="btn btn-primary text-xs" type="submit">Compare</button>
        <span className="flex-1" />
        {valid && !conflict && (
          <a href={`/${org}/${repo}/pulls/new?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`}
             className="btn btn-primary text-xs">Open pull request</a>
        )}
      </form>

      {!valid ? (
        <div className="card p-6 text-center text-[var(--text-dim)] text-[13px]">
          Pick two different branches to compare. {branches.length < 2 && "Push another branch first."}
        </div>
      ) : (
        <>
          <div className="flex items-baseline gap-3 mb-2 text-[13px] text-[var(--text-dim)] flex-wrap">
            <span className="mono">{head}</span>
            <span>will merge into</span>
            <span className="mono">{base}</span>
            <span className="flex-1" />
            <span>{commits.length} commit{commits.length === 1 ? "" : "s"}</span>
            <span className="text-[var(--green)]">+{totalAdd}</span>
            <span className="text-[var(--red)]">−{totalDel}</span>
          </div>

          {conflict && (
            <div className="card p-3 mb-4 text-[13px] text-[var(--yellow)] border-[var(--yellow)]">
              These branches have diverged — <span className="mono">{head}</span> is not ahead of{" "}
              <span className="mono">{base}</span> (merge will need a merge commit or rebase).
            </div>
          )}

          {commits.length > 0 && (
            <div className="card divide-y mb-4">
              {commits.map((c) => (
                <a key={c.sha} href={`/${org}/${repo}/commits/${c.sha}`} className="block px-4 py-2.5 hover:bg-[var(--bg-hover)]">
                  <div className="flex items-baseline gap-3">
                    <span className="mono text-xs text-[var(--accent)] shrink-0">{c.sha.slice(0, 7)}</span>
                    <span className="text-[13px] flex-1 truncate">{c.message}</span>
                    <span className="text-xs text-[var(--text-faint)] shrink-0">{c.authorName}</span>
                  </div>
                </a>
              ))}
            </div>
          )}

          <div className="space-y-4">
            {diff.length === 0 && (
              <div className="card p-6 text-center text-[var(--text-dim)] text-[13px]">No file changes.</div>
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
                          <CompareHunk key={hi} hunk={h} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CompareHunk({ hunk }: { hunk: import("@forge/shared").DiffHunk }) {
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
