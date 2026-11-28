// /[org]/[repo]/blame/[[...path]] — per-line file authorship (git blame).

import { findVisibleRepo } from "@/server/authz";
import { listBranchesDb, resolveBranchSha, repoBlob } from "@/server/api";
import { repoGitDir, blameFile, revParse, isBinary } from "@forge/git";
import Link from "next/link";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ org: string; repo: string; path?: string[] }>;
  searchParams: Promise<{ ref?: string }>;
}

export default async function BlamePage({ params, searchParams }: PageProps) {
  const { org, repo, path } = await params;
  const { ref: branchParam } = await searchParams;
  const filePath = (path ?? []).join("/");

  const info = await findVisibleRepo(org, repo);
  if (!info) return <div className="text-[var(--text-dim)]">not found</div>;

  const branches = await listBranchesDb(info.repoId);
  const branch = branchParam && branches.includes(branchParam) ? branchParam : info.defaultBranch;
  const gitDir = repoGitDir(org, repo);
  const sha = await revParse(gitDir, branch);
  if (!sha || !filePath) {
    return <div className="text-[var(--text-dim)] text-[13px]">Nothing to blame — pick a file first.</div>;
  }

  // Refuse binaries and oversized blobs.
  const blobSha = await revParse(gitDir, `${sha}:${filePath}`);
  if (!blobSha) return <div className="text-[var(--text-dim)] text-[13px]">File not found: {filePath}</div>;
  if (await isBinary(gitDir, blobSha)) {
    return <div className="text-[var(--text-dim)] text-[13px]">Binary files cannot be blamed.</div>;
  }

  const lines = await blameFile(gitDir, sha, filePath);
  if (lines === null) {
    return <div className="text-[var(--text-dim)] text-[13px]">Blame unavailable (file too large).</div>;
  }

  // Group consecutive same-commit runs for the gutter.
  const runs: Array<{ line: (typeof lines)[number]; count: number }> = [];
  for (const line of lines) {
    const last = runs[runs.length - 1];
    if (last && last.line.sha === line.sha && last.line.authorName === line.authorName) {
      last.count++;
    } else {
      runs.push({ line, count: 1 });
    }
  }

  return (
    <div>
      <div className="flex items-baseline gap-3 mb-3 flex-wrap">
        <h1 className="text-lg font-semibold">Blame</h1>
        <span className="mono text-[13px] text-[var(--accent)]">{filePath}</span>
        <span className="text-xs text-[var(--text-faint)] mono">@ {branch}</span>
        <span className="flex-1" />
        <Link href={`/${org}/${repo}?ref=${encodeURIComponent(branch)}&path=${encodeURIComponent(filePath)}`}
          className="text-xs text-[var(--text-dim)] hover:text-[var(--text)]">← code</Link>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-[12.5px] mono" style={{ borderCollapse: "collapse" }}>
          <tbody>
            {runs.map((run, ri) => (
              <BlameRun key={ri} org={org} repo={repo} run={run} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-xs text-[var(--text-faint)]">{lines.length} lines</div>
    </div>
  );
}

function BlameRun({ org, repo, run }: {
  org: string; repo: string;
  run: { line: { sha: string; authorName: string; authoredAt: string; lineNumber: number; content: string }; count: number };
}) {
  const cells = [];
  for (let i = 0; i < run.count; i++) {
    const lineNo = run.line.lineNumber + i;
    cells.push(
      <tr key={lineNo}>
        {i === 0 ? (
          <td rowSpan={run.count} className="align-top border-r px-3 py-0.5 whitespace-nowrap w-56 text-[var(--text-faint)]">
            <a href={`/${org}/${repo}/commits/${run.line.sha}`} className="text-[var(--accent)] hover:underline">
              {run.line.sha.slice(0, 7)}
            </a>{" "}
            {run.line.authorName} {timeAgo(run.line.authoredAt)}
          </td>
        ) : null}
        <td className="px-2 text-right text-[var(--text-faint)] select-none w-10 border-r">{lineNo}</td>
        <td className="px-3 whitespace-pre-wrap break-all">{run.line.content}</td>
      </tr>,
    );
  }
  return <>{cells}</>;
}

function timeAgo(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 365) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / 86400 / 365)}y`;
}
