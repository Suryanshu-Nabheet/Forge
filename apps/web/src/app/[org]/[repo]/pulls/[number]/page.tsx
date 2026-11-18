import { findVisibleRepo } from "@/server/authz";
import { getPr, prDiff, prComments, prPreviews, prJobEvents } from "@/server/api";
import { repoGitDir } from "@forge/git";
import { prRiskColor, riskLabel } from "@/components/risk";
import { PrActions } from "@/components/PrActions";
import { LiveLogs } from "@/components/LiveLogs";

export const dynamic = "force-dynamic";

export default async function PrPage({ params }: { params: Promise<{ org: string; repo: string; number: string }> }) {
  const { org, repo, number } = await params;
  const num = Number(number);
  const info = await findVisibleRepo(org, repo);
  if (!info) return <div className="text-[var(--text-dim)]">not found</div>;
  const pr = await getPr(info.repoId, num);
  if (!pr) return <div className="text-[var(--text-dim)]">PR #{num} not found</div>;

  const gitDir = repoGitDir(org, repo);
  const [diff, comments, previews, jobEvents] = await Promise.all([
    prDiff(gitDir, pr.baseSha, pr.headSha),
    prComments(pr.id),
    prPreviews(pr.id),
    prJobEvents(pr.id),
  ]);

  const aiComments = comments.filter((c) => c.kind === "ai_review");
  const humanComments = comments.filter((c) => c.kind === "human");
  const latestPreview = previews[0] ?? null;
  const totalAdd = diff.reduce((n, f) => n + f.additions, 0);
  const totalDel = diff.reduce((n, f) => n + f.deletions, 0);

  return (
    <div>
      <div className="flex items-baseline gap-3 flex-wrap mb-1">
        <h1 className="text-lg font-semibold">{pr.title}</h1>
        <span className="text-[var(--text-faint)]">#{pr.number}</span>
        <StatusBadge status={pr.status} />
      </div>
      <div className="text-[13px] text-[var(--text-dim)] mb-4 mono">
        {pr.headBranch} → {pr.baseBranch} · {totalAdd}+ {totalDel}− · {diff.length} file{diff.length === 1 ? "" : "s"}
      </div>

      {/* AI risk card */}
      {pr.riskScore !== null && (
        <div className="card p-4 mb-4 flex items-center gap-4">
          <div className={`text-2xl font-bold mono ${prRiskColor(pr.riskScore)}`}>{Math.round(pr.riskScore)}</div>
          <div className="flex-1">
            <div className="text-[13px] font-medium">Autonomous review · risk {riskLabel(pr.riskScore)}</div>
            <div className="text-[13px] text-[var(--text-dim)]">{pr.riskSummary}</div>
          </div>
        </div>
      )}

      {/* Preview card */}
      {latestPreview && (
        <div className="card p-4 mb-4">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="font-medium">Ephemeral preview</span>
            <PreviewStatus status={latestPreview.status} adapter={latestPreview.adapter} />
            <span className="flex-1" />
            <span className="mono text-xs text-[var(--text-faint)]">{latestPreview.commitSha.slice(0, 7)}</span>
            {latestPreview.durationMs !== null && (
              <span className="mono text-xs text-[var(--text-faint)]">{(latestPreview.durationMs / 1000).toFixed(1)}s</span>
            )}
          </div>
          <LiveLogs org={org} repo={repo} prNumber={pr.number} initial={jobEvents.map((e) => ({ id: e.id, level: e.level, message: e.message }))} />
        </div>
      )}

      {/* Actions */}
      <PrActions org={org} repo={repo} number={pr.number} status={pr.status} />

      {/* Diff */}
      <div className="space-y-4">
        {diff.length === 0 && <div className="card p-6 text-center text-[var(--text-dim)] text-[13px]">No changes or diff unavailable.</div>}
        {diff.map((f) => (
          <DiffFileCard key={f.path} file={f} comments={aiComments.concat(humanComments)} />
        ))}
      </div>

      <div className="mt-6 text-[13px] text-[var(--text-dim)]">
        {aiComments.length} AI finding{aiComments.length === 1 ? "" : "s"} · {humanComments.length} human comment{humanComments.length === 1 ? "" : "s"}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color = status === "open" ? "text-[var(--purple)]" : status === "merged" ? "text-[var(--green)]" : "text-[var(--text-faint)]";
  return <span className={`text-xs ${color}`}>{status === "open" ? "●" : status === "merged" ? "✓" : "✕"} {status}</span>;
}

function PreviewStatus({ status, adapter }: { status: string; adapter: string }) {
  const map: Record<string, string> = {
    queued: "text-[var(--text-faint)]",
    building: "text-[var(--yellow)]",
    running: "text-[var(--green)]",
    failed: "text-[var(--red)]",
    exited: "text-[var(--text-faint)]",
  };
  return (
    <span className={`text-xs ${map[status] ?? ""}`}>
      {status === "building" ? "⟳" : status === "running" ? "●" : status === "failed" ? "✕" : "○"} {status} ({adapter})
    </span>
  );
}

function DiffFileCard({ file, comments }: {
  file: import("@forge/shared").DiffFile;
  comments: Array<{ path: string | null; line: number | null; side: string | null; body: string; kind: string; severity: string | null }>;
}) {
  const fileComments = comments.filter((c) => c.path === file.newPath || c.path === file.oldPath);
  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-2 border-b flex items-center gap-2 text-[13px]">
        <span className="mono">{file.path}</span>
        <span className="text-xs text-[var(--green)]">+{file.additions}</span>
        <span className="text-xs text-[var(--red)]">−{file.deletions}</span>
        <span className="flex-1" />
        <span className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">{file.status}</span>
      </div>
      {file.isBinary ? (
        <div className="px-4 py-6 text-center text-[var(--text-dim)] text-[13px]">Binary file</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px] mono" style={{ borderCollapse: "collapse" }}>
            <tbody>
              {file.hunks.map((h, hi) => (
                <HunkBlock key={hi} hunk={h} fileComments={fileComments} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function HunkBlock({ hunk, fileComments }: {
  hunk: import("@forge/shared").DiffHunk;
  fileComments: Array<{ path: string | null; line: number | null; side: string | null; body: string; kind: string; severity: string | null }>;
}) {
  return (
    <>
      <tr>
        <td colSpan={3} className="px-4 py-1 text-[11px] text-[var(--text-faint)] bg-[var(--bg-hover)] mono border-y">
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
        </td>
      </tr>
      {hunk.lines.map((l, li) => {
        const lineComments = l.newLine !== null
          ? fileComments.filter((c) => c.side === "new" && c.line === l.newLine)
          : [];
        const bg = l.type === "add" ? "color-mix(in srgb, var(--green) 10%, var(--bg))" : l.type === "remove" ? "color-mix(in srgb, var(--red) 10%, var(--bg))" : "transparent";
        const marker = l.type === "add" ? "+" : l.type === "remove" ? "−" : " ";
        const num = l.type === "remove" ? l.oldLine : l.newLine;
        return (
          <tr key={li} style={{ background: bg }}>
            <td className="pl-4 pr-2 text-[var(--text-faint)] select-none w-10 text-right align-top">{l.oldLine ?? ""}</td>
            <td className="px-1 text-[var(--text-faint)] select-none w-10 text-right align-top border-r">{l.newLine ?? ""}</td>
            <td className="pl-3 pr-4 whitespace-pre-wrap break-all" style={{ width: "99%" }}>
              <span className={l.type === "add" ? "text-[var(--green)]" : l.type === "remove" ? "text-[var(--red)]" : ""}>{marker} </span>
              {l.content}
              {lineComments.map((c, ci) => (
                <div key={ci} className={`my-1.5 p-2.5 rounded text-[12px] mono border ${
                  c.severity === "critical" ? "border-[var(--red)] bg-[color-mix(in_srgb,var(--red)_6%,transparent)]" :
                  c.severity === "warning" ? "border-[var(--yellow)] bg-[color-mix(in_srgb,var(--yellow)_6%,transparent)]" :
                  "border-[var(--border-strong)]"
                }`}>
                  <div className="text-[10px] uppercase tracking-wide text-[var(--text-faint)] mb-1">
                    {c.kind === "ai_review" ? "🤖 autonomous reviewer" : "human"} {c.severity ? `· ${c.severity}` : ""}
                  </div>
                  <div className="whitespace-pre-wrap" style={{ fontFamily: "inherit" }}>{c.body.replace(/\*\*/g, "")}</div>
                </div>
              ))}
            </td>
          </tr>
        );
      })}
      <tr>
        <td colSpan={3} className="h-1 bg-[var(--bg-hover)]" />
      </tr>
    </>
  );
}
