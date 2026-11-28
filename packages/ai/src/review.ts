// PR review engine: Claude mode (full-diff analysis via SDK) +
// heuristic mode (deterministic static analysis). Same output shape.

import type { DiffFile, ReviewAnalysis, ReviewFinding } from "@forge/shared";
import { aiMode } from "./client";
import { embedLocal, cosine } from "./embeddings";

export async function analyzeDiffForReview(diff: DiffFile[]): Promise<ReviewAnalysis> {
  if (aiMode() === "claude") {
    try {
      return await claudeReview(diff);
    } catch (err) {
      console.warn("[ai] claude review failed, falling back to heuristic:", err);
      return heuristicReview(diff);
    }
  }
  return heuristicReview(diff);
}

// ---------- heuristic mode (deterministic) ----------

interface Rule {
  id: string;
  category: ReviewFinding["category"];
  severity: ReviewFinding["severity"];
  pattern: RegExp;
  title: string;
  detail: (m: RegExpExecArray, line: string) => string;
  languages?: string[];
}

const RULES: Rule[] = [
  {
    id: "secret-aws",
    category: "security",
    severity: "critical",
    pattern: /AKIA[0-9A-Z]{16}/,
    title: "AWS access key committed",
    detail: () => "This looks like an AWS access key ID. Rotate the key immediately and never commit credentials.",
  },
  {
    id: "secret-generic",
    category: "security",
    severity: "critical",
    pattern: /(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,}["']/i,
    title: "Hard-coded secret",
    detail: (m) => `Hard-coded credential detected (\`${m[1]}\`). Move it to an environment variable or secret manager.`,
  },
  {
    id: "danger-eval",
    category: "security",
    severity: "critical",
    pattern: /\beval\s*\(/,
    title: "Use of eval()",
    detail: () => "`eval` executes arbitrary code. If you need dynamic behavior, use a parser or lookup table instead.",
  },
  {
    id: "danger-exec-concat",
    category: "security",
    severity: "critical",
    pattern: /(execSync|exec|spawnSync|spawn)\s*\(\s*[`"'][^`"']*[$`"']/,
    title: "Command execution with string interpolation",
    detail: () => "Spawning a process with a concatenated/interpolated string risks command injection. Pass an argv array instead.",
  },
  {
    id: "sql-concat",
    category: "security",
    severity: "critical",
    pattern: /(query|execute)\s*\(\s*[`"'][^`"']*\$\{/i,
    title: "SQL built via string interpolation",
    detail: () => "SQL assembled with template interpolation is a SQL-injection risk. Use parameterized queries.",
  },
  {
    id: "unawaited-promise",
    category: "logic",
    severity: "warning",
    pattern: /^\s*(?:const|let|var)?\s*\w+\s*=\s*\w+\.\s*(create|find\w*|update\w*|delete\w*|insert\w*)\(/,
    title: "Possible un-awaited async call",
    detail: () => "This call returns a promise. If it isn't awaited, errors are silently swallowed and ordering breaks.",
    languages: ["ts", "js"],
  },
  {
    id: "proto-pollution",
    category: "security",
    severity: "critical",
    pattern: /(__proto__|constructor\s*\[|prototype\s*\[)\s*=/,
    title: "Prototype pollution sink",
    detail: () => "Assigning to `__proto__`/`constructor[...]` pollutes every object sharing the prototype. Validate keys against an allowlist first.",
  },
  {
    id: "react-setstate-render",
    category: "logic",
    severity: "warning",
    pattern: /^\s*set[A-Z]\w*\s*\(/,
    title: "setState during render?",
    detail: () => "Calling a state setter unconditionally during render causes an infinite loop. Move it to an effect or event handler.",
    languages: ["tsx", "jsx"],
  },
];

const TEST_PATH_RE = /(^|\/)(tests?|__tests__)\//i;
const isTestPath = (p: string) => TEST_PATH_RE.test(p);
const TEST_FILE_RE = /\.(test|spec)\.[a-z]+$/i;

/** Detect source files changed without corresponding test-file changes. */
function missingTests(diff: DiffFile[]): string[] {
  const changedTests = new Set(
    diff
      .filter((f) => TEST_FILE_RE.test(f.newPath ?? "") || TEST_FILE_RE.test(f.oldPath ?? ""))
      .map((f) => f.newPath ?? f.oldPath ?? ""),
  );
  const missing: string[] = [];
  for (const f of diff) {
    const p = f.newPath ?? f.oldPath;
    if (!p) continue;
    if (TEST_FILE_RE.test(p) || isTestPath(p)) continue;
    if (!/\.(ts|tsx|js|jsx|py|go|rs)$/.test(p)) continue;
    const stem = p.replace(/\.[^.]+$/, "");
    const hasTest = [...changedTests].some((t) => {
      const tStem = t.replace(/\.(test|spec)\.[^.]+$/, "");
      return tStem === stem || tStem.endsWith(stem) || stem.endsWith(tStem);
    });
    if (!hasTest) missing.push(p);
  }
  return missing;
}

export function heuristicReview(diff: DiffFile[]): ReviewAnalysis {
  const findings: ReviewFinding[] = [];
  const mode = aiMode();

  for (const file of diff) {
    if (file.isBinary) continue;
    const lang = (file.newPath ?? file.oldPath ?? "").split(".").pop() ?? "";
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "remove") continue;
        for (const rule of RULES) {
          if (rule.languages && !rule.languages.includes(lang)) continue;
          const m = rule.pattern.exec(line.content);
          if (!m) continue;
          findings.push({
            path: file.newPath ?? file.oldPath ?? "",
            line: line.newLine,
            side: "new",
            severity: rule.severity,
            category: rule.category,
            title: rule.title,
            detail: rule.detail(m, line.content),
          });
        }
      }
    }
  }

  const missing = missingTests(diff);
  if (missing.length > 0) {
    findings.push({
      path: missing[0]!,
      line: null,
      side: "new",
      severity: "warning",
      "category": "tests",
      title: "Missing test coverage for changed files",
      detail:
        `The diff changes ${missing.length} source file${missing.length === 1 ? "" : "s"} without test changes: ` +
        missing.slice(0, 10).map((p) => `\`${p}\``).join(", ") +
        `${missing.length > 10 ? " …" : ""}. Consider adding tests for the changed behavior.`,
    });
  }

  // Deduplicate identical findings (same path+line+rule).
  const seen = new Set<string>();
  const unique = findings.filter((f) => {
    const key = `${f.path}:${f.line}:${f.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Risk score: weighted by severity, normalized to 0..100.
  const weight = { critical: 12, warning: 5, info: 1 };
  let score = 0;
  for (const f of unique) score += weight[f.severity];
  score += Math.min(10, Math.floor(diff.reduce((n, f) => n + f.additions + f.deletions, 0) / 100));
  const riskScore = Math.min(100, score);

  const criticals = unique.filter((f) => f.severity === "critical").length;
  const summary =
    unique.length === 0
      ? "No issues found by the heuristic analyzer. The diff looks clean."
      : `${unique.length} finding${unique.length === 1 ? "" : "s"}: ${criticals} critical, ${unique.filter((f) => f.severity === "warning").length} warning. ` +
        (criticals > 0 ? "Block until criticals are resolved." : "Non-blocking observations.");

  return { summary, riskScore, findings: unique, missingTestsFor: missing, mode };
}

// ---------- claude mode ----------

async function claudeReview(diff: DiffFile[]): Promise<ReviewAnalysis> {
  const { getClaude, textOf } = await import("./client");
  const client = await getClaude();
  if (!client) return heuristicReview(diff);

  const diffText = renderDiffForPrompt(diff).slice(0, 100_000);
  const response = await client.messages.create({
    model: "claude-sonnet-5-5",
    max_tokens: 4000,
    messages: [
      {
        role: "user",
        content: `You are an expert code reviewer for a pull request. Analyze this diff and respond with ONLY a JSON object (no markdown fences) matching this TypeScript type:

type ReviewAnalysis = { summary: string; riskScore: number; findings: Array<{ path: string; line: number | null; side: "old" | "new"; severity: "info" | "warning" | "critical"; category: "security" | "logic" | "tests" | "style" | "performance"; title: string; detail: string; suggestion?: string }>; missingTestsFor: string[]; mode: "claude" }

DIFF:
${diffText}`,
      },
    ],
  });

  const text = textOf(response);
  const parsed = parseReviewAnalysis(text);
  return { ...parsed, mode: "claude" };
}

const SEVERITIES = new Set(["info", "warning", "critical"]);
const CATEGORIES = new Set(["security", "logic", "tests", "style", "performance"]);

/** Extract the outermost JSON object from a model response. */
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON in claude response");
  return text.slice(start, end + 1);
}

/** Parse + shape-validate a Claude review response; falls back to a safe default on garbage. */
export function parseReviewAnalysis(text: string): ReviewAnalysis {
  const raw: unknown = JSON.parse(extractJson(text));
  const obj = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
  const summary = typeof obj.summary === "string" ? obj.summary : "Review completed, but the analysis output was malformed.";
  const riskScore = typeof obj.riskScore === "number" && Number.isFinite(obj.riskScore)
    ? Math.max(0, Math.min(100, Math.round(obj.riskScore)))
    : 0;
  const findings: ReviewFinding[] = Array.isArray(obj.findings)
    ? obj.findings.flatMap((f): ReviewFinding[] => {
        if (!f || typeof f !== "object") return [];
        const r = f as Record<string, unknown>;
        if (typeof r.path !== "string" || typeof r.title !== "string" || typeof r.detail !== "string") return [];
        const severity = SEVERITIES.has(r.severity as string) ? (r.severity as ReviewFinding["severity"]) : "warning";
        const category = CATEGORIES.has(r.category as string) ? (r.category as ReviewFinding["category"]) : "logic";
        const side: "old" | "new" = r.side === "old" ? "old" : "new";
        const line = typeof r.line === "number" && Number.isInteger(r.line) && r.line >= 0 ? r.line : null;
        const suggestion = typeof r.suggestion === "string" ? r.suggestion : undefined;
        return [{ path: r.path, line, side, severity, category, title: r.title, detail: r.detail, suggestion }];
      })
    : [];
  const missingTestsFor = Array.isArray(obj.missingTestsFor)
    ? obj.missingTestsFor.filter((p): p is string => typeof p === "string")
    : [];
  return { summary, riskScore, findings, missingTestsFor, mode: "claude" };
}

function renderDiffForPrompt(diff: DiffFile[]): string {
  const parts: string[] = [];
  for (const f of diff) {
    if (f.isBinary) continue;
    parts.push(`--- ${f.oldPath} → ${f.newPath} (${f.status})`);
    for (const h of f.hunks) {
      parts.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
      for (const l of h.lines) {
        parts.push((l.type === "add" ? "+" : l.type === "remove" ? "-" : " ") + l.content);
      }
    }
  }
  return parts.join("\n");
}

// ---------- issue auto-triage (deterministic) ----------

const LABEL_RULES: Array<{ label: string; test: RegExp }> = [
  { label: "security", test: /\b(security|vulnerab(?:le|ility)|cve|exploit|xss|csrf|injection|auth(?:oriz|ent)(?:ation|ed)?|privilege|secret|leak)\b/i },
  { label: "bug", test: /\b(bug|crash(?:es)?|error|failing|broken|regression|exception|panic|500|npe|null pointer)\b/i },
  { label: "performance", test: /\b(slow|performance|latency|timeout|optimiz\w*|memory leak|throughput)\b/i },
  { label: "feature", test: /\b(feature|add support|implement|new command|would be nice|request:|rfc)\b/i },
  { label: "documentation", test: /\b(docs?|documentation|readme|comment|example)\b/i },
  { label: "ui", test: /\b(ui|ux|layout|styling|css|dark mode|mobile|tooltip|button)\b/i },
  { label: "git", test: /\b(clone|push|pull|fetch|rebase|merge|branch|hook|ref)\b/i },
  { label: "ai", test: /\b(ai|llm|claude|prompt|embedding|semantic|reviewer)\b/i },
  { label: "infrastructure", test: /\b(deploy|docker|compose|kubernetes|migration|database|postgres|redis|backup)\b/i },
];

/**
 * Deterministic issue triage: suggest labels from the title+description.
 * Capped at 3 labels, priority-ordered (security > bug > performance …)
 * so the most actionable signal wins. Empty when nothing matches — the
 * caller keeps user-supplied labels either way.
 */
export function triageLabels(title: string, description: string): string[] {
  const text = `${title}\n${description ?? ""}`;
  const hits: string[] = [];
  for (const rule of LABEL_RULES) {
    if (rule.test.test(text)) hits.push(rule.label);
    if (hits.length >= 3) break;
  }
  return hits;
}

// ---------- duplicate issue detection (deterministic) ----------

/**
 * Rank existing issues by embedding similarity to a new issue's
 * title+description. Returns the ids/numbers of up to `max` issues
 * whose similarity meets the threshold — a lightweight "possible
 * duplicate" signal surfaced at creation time. Pure function: the
 * caller supplies (number, text, embedding) triples.
 */
export function findDuplicateIssues(
  candidate: { title: string; description: string },
  existing: Array<{ number: number; title: string; description: string | null; embedding: number[] }>,
  opts?: { threshold?: number; max?: number },
): Array<{ number: number; similarity: number }> {
  
  const threshold = opts?.threshold ?? 0.42;
  const max = opts?.max ?? 3;
  const qv = embedLocal(`${candidate.title}\n${candidate.description ?? ""}`, null);
  return existing
    .map((e) => ({
      number: e.number,
      similarity: cosine(qv, e.embedding),
    }))
    .filter((x) => x.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, max);
}
