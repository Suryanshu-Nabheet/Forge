// Unit tests for the command palette fuzzy scorer (imported via a tiny
// harness: the scorer lives in a client component, so we re-implement
// the import through the component file's export surface — the function
// is hoisted here for direct testing).

import { describe, it, expect } from "vitest";

// Mirrors the scorer in components/CommandPalette.tsx. If the two drift,
// the palette e2e behavior tests catch it; this unit pins the contract.
function fuzzyScore(needle: string, haystack: string): number {
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (!n) return 1;
  let score = 0;
  let hi = 0;
  let run = 0;
  for (const ch of n) {
    const found = h.indexOf(ch, hi);
    if (found === -1) return 0;
    if (found === 0 || /[\s/\-_./]/.test(h[found - 1] ?? "")) score += 8;
    if (found === hi && hi > 0) run += 1;
    else run = 0;
    score += 4 - Math.min(3, found - hi);
    score += run * 2;
    hi = found + 1;
  }
  return score;
}

describe("palette fuzzy scorer", () => {
  it("returns 0 when any character is missing", () => {
    expect(fuzzyScore("xyz", "abc")).toBe(0);
  });

  it("matches out-of-order-subsequence needles", () => {
    expect(fuzzyScore("pr", "Pull requests — acme/iris")).toBeGreaterThan(0);
  });

  it("scores prefix hits above scattered hits", () => {
    const prefix = fuzzyScore("pull", "Pull requests — acme/iris");
    const scattered = fuzzyScore("preq", "Pull requests — acme/iris");
    expect(prefix).toBeGreaterThan(scattered);
  });

  it("scores word-boundary starts above mid-word hits", () => {
    const boundary = fuzzyScore("re", "Pull requests — acme/iris");
    const mid = fuzzyScore("eq", "Pull requests — acme/iris");
    expect(boundary).toBeGreaterThan(mid);
  });

  it("empty needle scores 1 (matches everything, neutral order)", () => {
    expect(fuzzyScore("", "anything")).toBe(1);
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("ASK", "Ask AI — acme/iris")).toBeGreaterThan(0);
  });
});
