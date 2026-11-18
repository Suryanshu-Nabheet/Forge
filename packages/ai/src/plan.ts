// Intent → implementation plan generator (Claude or heuristic template).

import type { ImplementationPlan } from "@forge/shared";
import type { EmbeddedChunk } from "./embeddings";
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
  // Derive candidate files from the semantic index: paths whose content
  // best matches the intent description are "files to modify".
  const relevant = chunks
    .filter((c) => c.kind === "symbol")
    .slice(0, 40);
  const pathScores = new Map<string, number>();
  for (const c of relevant) {
    pathScores.set(c.path, (pathScores.get(c.path) ?? 0) + 1);
  }
  const filesToModify = [...pathScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
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
    branchName: `i-unknown-${slug}`.replace("unknown-", ""),
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
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const parsed = JSON.parse(text.slice(start, end + 1)) as ImplementationPlan;
  return parsed;
}
