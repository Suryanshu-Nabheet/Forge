// Intent → implementation plan generator (Claude or heuristic template).

import type { ImplementationPlan } from "@forge/shared";
import type { EmbeddedChunk } from "./embeddings";
import { embedLocal, cosine } from "./embeddings";
import { aiMode } from "./client";

export interface PlanInput {
  title: string;
  description: string;
}

export async function generatePlan(input: PlanInput, chunks: EmbeddedChunk[]): Promise<ImplementationPlan> {
  if (aiMode() === "claude") {
    try {
      return await claudePlan(input, chunks);
    } catch (err) {
      console.warn("[ai] claude plan failed, falling back to heuristic:", err);
    }
  }
  return heuristicPlan(input, chunks);
}

function heuristicPlan(input: PlanInput, chunks: EmbeddedChunk[]): ImplementationPlan {
  const slug = slugify(input.title);
  // Rank candidate files by embedding similarity to the intent description,
  // aggregating per path (best chunk score wins, ties broken by frequency).
  const qv = embedLocal(`${input.title}\n${input.description}`, null);
  const pathScores = new Map<string, { best: number; count: number }>();
  for (const c of chunks) {
    if (c.kind !== "symbol") continue;
    const s = cosine(qv, c.embedding);
    const cur = pathScores.get(c.path);
    if (cur) {
      cur.best = Math.max(cur.best, s);
      cur.count += 1;
    } else {
      pathScores.set(c.path, { best: s, count: 1 });
    }
  }
  const filesToModify = [...pathScores.entries()]
    .sort((a, b) => b[1].best - a[1].best || b[1].count - a[1].count)
    .slice(0, 4)
    .filter(([, v]) => v.best > 0)
    .map(([path]) => ({ path, purpose: `Likely touchpoint for "${input.title}" (matched by semantic index)` }));

  return {
    overview: `Implement "${input.title}". ${firstSentence(input.description)}`,
    filesToCreate: [
      { path: `src/${slug}/index.ts`, purpose: "Entry module for the new capability" },
      { path: `src/${slug}/${slug}.test.ts`, purpose: "Tests for the new capability" },
      { path: `docs/intents/${slug}.md`, purpose: "Spec document tracking intent ↔ code linkage" },
    ],
    filesToModify,
    steps: [
      "Create the branch from main and open a draft PR early.",
      "Write the spec doc: problem, approach, acceptance criteria.",
      "Implement the core module with tests (TDD where practical).",
      "Wire into existing touchpoints listed above.",
      "Run typecheck, lint, tests; let the autonomous reviewer pass over the diff.",
      "Update the intent status to in_review and request review.",
    ],
    acceptanceCriteria: [
      "All tests pass; no type or lint errors.",
      "The autonomous PR reviewer reports no critical findings.",
      "Documentation updated in docs/intents.",
    ],
    risks: [
      "Scope creep: keep the first PR minimal and iterate.",
      "Semantic suggestions may point at stale code — verify touchpoints before editing.",
    ],
    branchName: `i-${slug}`,
  };
}

function firstSentence(s: string): string {
  const t = s.trim();
  const m = /^.{0,300}?(?:[.!?]|$)/.exec(t);
  return (m?.[0] ?? t).trim();
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
}

async function claudePlan(input: PlanInput, chunks: EmbeddedChunk[]): Promise<ImplementationPlan> {
  const { getClaude, textOf } = await import("./client");
  const client = await getClaude();
  if (!client) return heuristicPlan(input, chunks);

  const context = chunks
    .slice(0, 30)
    .map((c) => `${c.path}:${c.lineStart}-${c.lineEnd}${c.symbol ? ` (${c.symbol})` : ""}\n${c.content.slice(0, 800)}`)
    .join("\n\n");

  const response = await client.messages.create({
    model: "claude-sonnet-5-5",
    max_tokens: 3000,
    messages: [
      {
        role: "user",
        content: `You are a principal engineer drafting an implementation plan. Respond with ONLY a JSON object (no markdown fences) matching:

type ImplementationPlan = { overview: string; filesToCreate: Array<{path: string; purpose: string}>; filesToModify: Array<{path: string; purpose: string}>; steps: string[]; acceptanceCriteria: string[]; risks: string[]; branchName: string }

INTENT TITLE: ${input.title}
INTENT DESCRIPTION: ${input.description}

CODEBASE CONTEXT (top semantic matches):
${context}`,
      },
    ],
  });
  const text = textOf(response);
  return parseImplementationPlan(text, input.title);
}

/** Parse + shape-validate a Claude plan response; throws on unusable output. */
export function parseImplementationPlan(text: string, fallbackTitle: string): ImplementationPlan {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON in claude response");
  const raw: unknown = JSON.parse(text.slice(start, end + 1));
  const obj = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
  const overview = typeof obj.overview === "string" ? obj.overview : "";
  const branchName = typeof obj.branchName === "string" && obj.branchName.trim()
    ? obj.branchName
    : `i-${slugify(fallbackTitle)}`;
  const parseFileList = (v: unknown): Array<{ path: string; purpose: string }> =>
    Array.isArray(v)
      ? v.flatMap((e) => {
          if (!e || typeof e !== "object") return [];
          const r = e as Record<string, unknown>;
          if (typeof r.path !== "string" || !r.path) return [];
          return [{ path: r.path, purpose: typeof r.purpose === "string" ? r.purpose : "" }];
        })
      : [];
  const parseStringList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  if (!overview && parseFileList(obj.filesToCreate).length === 0 && parseStringList(obj.steps).length === 0) {
    throw new Error("claude plan output missing required fields");
  }
  return {
    overview,
    filesToCreate: parseFileList(obj.filesToCreate),
    filesToModify: parseFileList(obj.filesToModify),
    steps: parseStringList(obj.steps),
    acceptanceCriteria: parseStringList(obj.acceptanceCriteria),
    risks: parseStringList(obj.risks),
    branchName,
  };
}
