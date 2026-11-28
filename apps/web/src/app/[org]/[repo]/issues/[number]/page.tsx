import { findVisibleRepo } from "@/server/authz";
import { getIntent, intentLinksFor } from "@/server/api";
import { db, pullRequests } from "@forge/db";
import { eq } from "drizzle-orm";
import { PlanActionsClient } from "@/components/PlanActionsClient";

export const dynamic = "force-dynamic";

export default async function IntentPage({ params }: { params: Promise<{ org: string; repo: string; number: string }> }) {
  const { org, repo, number } = await params;
  const num = Number(number);
  const info = await findVisibleRepo(org, repo);
  if (!info) return <div className="text-[var(--text-dim)]">not found</div>;
  const intent = await getIntent(info.repoId, num);
  if (!intent) return <div className="text-[var(--text-dim)]">Intent #{num} not found</div>;
  const links = await intentLinksFor(intent.id);
  const linkedPrRow = intent.linkedPrId
    ? (await db.select().from(pullRequests).where(eq(pullRequests.id, intent.linkedPrId)).limit(1))[0]
    : null;

  return (
    <div className="max-w-3xl">
      <div className="flex items-baseline gap-3 mb-1">
        <h1 className="text-lg font-semibold">{intent.title}</h1>
        <span className="text-[var(--text-faint)]">#{intent.number}</span>
      </div>
      <div className="text-[13px] text-[var(--text-dim)] mb-4">
        {intent.status} · {intent.kind} · branch {intent.branchName ?? "—"}
        {linkedPrRow && (
          <> · <a className="text-[var(--accent)]" href={`/${org}/${repo}/pulls/${linkedPrRow.number}`}>PR #{linkedPrRow.number}</a></>
        )}
      </div>

      <div className="card p-4 mb-4 whitespace-pre-wrap text-[13px]">
        {intent.description || "No description."}
      </div>

      {/* AI plan */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-base font-semibold">Implementation plan</h2>
          <PlanActions org={org} repo={repo} number={num} hasPlan={intent.planState === "ready"} />
        </div>
        {intent.planState === "drafting" && (
          <div className="card p-4 text-[13px] text-[var(--yellow)]">⟳ Drafting plan… (background worker running)</div>
        )}
        {intent.plan && (
          <div className="card p-4 text-[13px] space-y-3">
            <p className="text-[var(--text-dim)]">{intent.plan.overview}</p>
            {intent.plan.filesToCreate.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide text-[var(--text-faint)] mb-1">Files to create</div>
                {intent.plan.filesToCreate.map((f) => (
                  <div key={f.path} className="mono text-[12.5px]">+ {f.path} <span className="text-[var(--text-faint)]">— {f.purpose}</span></div>
                ))}
              </div>
            )}
            {intent.plan.filesToModify.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide text-[var(--text-faint)] mb-1">Files to modify</div>
                {intent.plan.filesToModify.map((f) => (
                  <div key={f.path} className="mono text-[12.5px]">~ {f.path} <span className="text-[var(--text-faint)]">— {f.purpose}</span></div>
                ))}
              </div>
            )}
            <div>
              <div className="text-xs uppercase tracking-wide text-[var(--text-faint)] mb-1">Steps</div>
              <ol className="list-decimal ml-5 space-y-1">
                {intent.plan.steps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-[var(--text-faint)] mb-1">Acceptance criteria</div>
              <ul className="list-disc ml-5 space-y-1">
                {intent.plan.acceptanceCriteria.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </div>
          </div>
        )}
        {!intent.plan && intent.planState !== "drafting" && (
          <div className="card p-4 text-[13px] text-[var(--text-dim)]">No plan yet — click “Draft implementation plan”.</div>
        )}
      </div>

      {/* links */}
      {links.length > 0 && (
        <div className="card p-4">
          <h2 className="text-sm font-semibold mb-2">Spec ↔ code lineage</h2>
          {links.map((l) => (
            <div key={l.id} className="text-[13px] mono">
              <span className="text-[var(--text-faint)]">{l.kind}</span> {l.value.slice(0, 12)}
              {l.kind === "pr" && <> — <a className="text-[var(--accent)]" href={`/${org}/${repo}/pulls/${l.value}`}>PR #{l.value}</a></>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PlanActions({ org, repo, number, hasPlan }: { org: string; repo: string; number: number; hasPlan: boolean }) {
  return <PlanActionsClient org={org} repo={repo} number={number} hasPlan={hasPlan} />;
}
