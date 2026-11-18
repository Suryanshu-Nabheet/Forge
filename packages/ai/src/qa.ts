// Semantic codebase Q&A: retrieval + extractive answer with citations (heuristic)
// or RAG answer via Claude (when key present).

import type { QaAnswer } from "@forge/shared";
import { aiMode } from "./client";
import { rankChunks, embedLocal, cosine, type EmbeddedChunk } from "./embeddings";

export async function answerQuestion(question: string, chunks: EmbeddedChunk[]): Promise<QaAnswer> {
  if (chunks.length === 0) {
    return {
      question,
      answer: "This repository hasn't been indexed yet (no chunks found). Push some code and try again.",
      citations: [],
      confidence: 0,
      mode: aiMode(),
    };
  }
  if (aiMode() === "claude") {
    try {
      return await claudeQa(question, chunks);
    } catch (err) {
      console.warn("[ai] claude QA failed, falling back to heuristic:", err);
    }
  }
  return heuristicQa(question, chunks);
}

function heuristicQa(question: string, chunks: EmbeddedChunk[]): QaAnswer {
  const top = rankChunksSync(question, chunks, 5);
  const citations = top.map((c) => ({
    path: c.path,
    lineStart: c.lineStart,
    lineEnd: c.lineEnd,
    symbol: c.symbol,
    snippet: firstMeaningfulLines(c.content),
  }));
  const sections = top.map((c, i) => {
    const loc = `${c.path}:${c.lineStart}-${c.lineEnd}${c.symbol ? ` (\`${c.symbol}\`)` : ""}`;
    return `**${i + 1}. ${loc}**\n${firstMeaningfulLines(c.content, 6)}`;
  });
  const answer =
    `Here's where this is handled, based on the semantic index:\n\n` +
    sections.join("\n\n") +
    `\n\nThe most relevant code is ${top[0] ? `\`${top[0].path}:${top[0].lineStart}\`` : "above"}.`;
  return {
    question,
    answer,
    citations,
    confidence: Math.min(0.95, 0.4 + top.length * 0.1),
    mode: "heuristic",
  };
}

function rankChunksSync(query: string, chunks: EmbeddedChunk[], topK: number): EmbeddedChunk[] {
  // rankChunks is async for API mode; heuristic path can call it sync via local embedder.
  return rankLocal(query, chunks, topK);
}

function rankLocal(query: string, chunks: EmbeddedChunk[], topK: number): EmbeddedChunk[] {
  // direct local ranking (imports at top of file; no require in ESM)
  const qv = embedLocal(query, null);
  return chunks
    .map((c) => ({ c, s: cosine(qv, c.embedding) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, topK)
    .map((x) => x.c);
}

function firstMeaningfulLines(content: string, maxLines = 4): string {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(0, maxLines).join("\n");
}

async function claudeQa(question: string, chunks: EmbeddedChunk[]): Promise<QaAnswer> {
  const { getClaude, textOf } = await import("./client");
  const client = await getClaude();
  if (!client) return heuristicQa(question, chunks);

  const top = await rankChunks(question, chunks, 8);
  const context = top
    .map((c, i) => `[${i}] ${c.path}:${c.lineStart}-${c.lineEnd}${c.symbol ? ` (${c.symbol})` : ""}\n${c.content.slice(0, 1500)}`)
    .join("\n\n");

  const response = await client.messages.create({
    model: "claude-sonnet-5-5",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: `Answer this question about a codebase using ONLY the cited excerpts. Cite every claim as [n] path:line. Question: ${question}

CODEBASE EXCERPTS:
${context}`,
      },
    ],
  });
  const text = textOf(response);
  return {
    question,
    answer: text,
    citations: top.map((c) => ({
      path: c.path,
      lineStart: c.lineStart,
      lineEnd: c.lineEnd,
      symbol: c.symbol,
      snippet: firstMeaningfulLines(c.content),
    })),
    confidence: 0.9,
    mode: "claude",
  };
}
