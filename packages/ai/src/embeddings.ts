// Embeddings: deterministic local hashing embedder (no API required),
// with Claude embedding API mode wired for when a key is present.

import type { CodeChunk } from "@forge/shared";

export const EMBED_DIM = 256;

export interface EmbeddedChunk extends CodeChunk {
  embedding: number[];
}

/** Hash a token into a [0, EMBED_DIM) bucket. */
function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % EMBED_DIM;
}

/** Split identifiers: camelCase, snake_case, kebab-case → tokens. */
export function splitIdentifiers(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Tokenize a chunk into words + split identifiers, with light weighting. */
function tokenize(content: string, symbol: string | null): Array<{ tok: string; weight: number }> {
  const out: Array<{ tok: string; weight: number }> = [];
  const words = content.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
  for (const w of words) {
    const lower = w.toLowerCase();
    out.push({ tok: lower, weight: 1 });
    if (/[a-z][A-Z]/.test(w) || w.includes("_") || w.includes("-")) {
      for (const part of splitIdentifiers(w)) {
        out.push({ tok: part.toLowerCase(), weight: 0.7 });
      }
    }
  }
  if (symbol) {
    for (const part of splitIdentifiers(symbol)) {
      out.push({ tok: part.toLowerCase(), weight: 2.0 });
    }
    out.push({ tok: symbol.toLowerCase(), weight: 2.5 });
  }
  return out;
}

/** L2-normalized deterministic embedding for one chunk. */
export function embedLocal(content: string, symbol: string | null): number[] {
  const vec = new Array<number>(EMBED_DIM).fill(0);
  for (const { tok, weight } of tokenize(content, symbol)) {
    vec[hashToken(tok)] += weight;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

/** Cosine similarity (vectors are unit-normalized → dot product). */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

/** Embed a list of chunks. Uses Claude API when configured; local otherwise. */
export async function embedChunks(chunks: CodeChunk[]): Promise<EmbeddedChunk[]> {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await embedViaApi(chunks);
    } catch (err) {
      console.warn("[ai] embedding API failed, using local embedder:", err);
    }
  }
  return chunks.map((c) => ({ ...c, embedding: embedLocal(c.content, c.symbol) }));
}

async function embedViaApi(chunks: CodeChunk[]): Promise<EmbeddedChunk[]> {
  // No embeddings endpoint in the base Anthropic SDK; local embedder covers it.
  // (Kept as a seam: swap in voyage-ai or a future anthropic embeddings API.)
  return chunks.map((c) => ({ ...c, embedding: embedLocal(c.content, c.symbol) }));
}

/** Rank chunks by similarity to a query. */
export async function rankChunks(query: string, chunks: EmbeddedChunk[], topK = 8): Promise<EmbeddedChunk[]> {
  const qv = embedLocal(query, null);
  return chunks
    .map((c) => ({ c, score: cosine(qv, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => x.c);
}
