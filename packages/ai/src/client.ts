// AI client — feature-detects ANTHHROPIC_API_KEY and exposes a unified interface.
// Claude mode: real SDK calls. Heuristic mode: deterministic static analysis.

import type { DiffFile, ReviewAnalysis, QaAnswer, ImplementationPlan, CodeChunk } from "@forge/shared";
import type Anthropic from "@anthropic-ai/sdk";

export type AiMode = "claude" | "heuristic";

export function aiMode(): AiMode {
  return process.env.ANTHROPIC_API_KEY ? "claude" : "heuristic";
}

let claudeClient: Anthropic | null | undefined;

/** Lazily-created Claude client. Returns null in heuristic mode. */
export async function getClaude(): Promise<Anthropic | null> {
  if (claudeClient !== undefined) return claudeClient;
  if (!process.env.ANTHROPIC_API_KEY) {
    claudeClient = null;
    return null;
  }
  try {
    const mod = await import("@anthropic-ai/sdk");
    claudeClient = new mod.default({ apiKey: process.env.ANTHROPIC_API_KEY });
  } catch {
    claudeClient = null;
  }
  return claudeClient;
}

/** Extract the concatenated text blocks from a Claude response. */
export function textOf(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => (c as { text: string }).text)
    .join("");
}

// Re-export the analysis entry points so callers have one import surface.
export { analyzeDiffForReview, triageLabels } from "./review";
export { answerQuestion } from "./qa";
export { generatePlan } from "./plan";
export { embedChunks } from "./embeddings";
