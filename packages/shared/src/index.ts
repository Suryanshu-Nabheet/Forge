// @forge/shared — domain types shared between web, worker, git transport, and AI layer.

export type Visibility = "public" | "private";

export type PrStatus = "open" | "merged" | "closed";
export type IntentStatus = "open" | "in_progress" | "in_review" | "merge_ready" | "done" | "closed";
export type IntentKind = "issue" | "spec" | "intent";
export type JobType = "semantic_index" | "pr_review" | "qa_answer" | "intent_plan" | "preview_build";
export type JobStatus = "queued" | "running" | "done" | "failed";
export type PreviewStatus = "queued" | "building" | "running" | "failed" | "exited";
export type CommentKind = "ai_review" | "ai_plan" | "human";
export type WebhookEventName = "push" | "pull_request" | "pr_merged" | "ping" | "release";

// ---------- Git ----------
export interface GitRefUpdate {
  ref: string;
  oldSha: string;
  newSha: string;
}

/** A single line inside a hunk. */
export interface DiffLine {
  type: "context" | "add" | "remove";
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  newPath: string | null;
  status: "added" | "removed" | "modified" | "renamed";
  additions: number;
  deletions: number;
  isBinary: boolean;
  hunks: DiffHunk[];
}

export interface CommitInfo {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committedAt: string;
  parentShas: string[];
  additions?: number;
  deletions?: number;
}

export interface TreeEntry {
  mode: string;
  type: "blob" | "tree" | "commit";
  path: string;
  size?: number;
  sha: string;
}

// ---------- AI ----------
export type FindingSeverity = "info" | "warning" | "critical";

export interface ReviewFinding {
  path: string;
  line: number | null;
  side: "old" | "new";
  severity: FindingSeverity;
  category: "security" | "logic" | "tests" | "style" | "performance";
  title: string;
  detail: string;
  suggestion?: string;
}

export interface ReviewAnalysis {
  summary: string;
  riskScore: number; // 0..100
  findings: ReviewFinding[];
  missingTestsFor: string[];
  mode: "claude" | "heuristic";
}

export interface CodeChunk {
  path: string;
  branch: string;
  lineStart: number;
  lineEnd: number;
  symbol: string | null;
  kind: "symbol" | "text";
  content: string;
}

export interface QaAnswer {
  question: string;
  answer: string;
  citations: Array<{ path: string; lineStart: number; lineEnd: number; symbol: string | null; snippet: string }>;
  confidence: number;
  mode: "claude" | "heuristic";
}

export interface ImplementationPlan {
  overview: string;
  filesToCreate: Array<{ path: string; purpose: string }>;
  filesToModify: Array<{ path: string; purpose: string }>;
  steps: string[];
  acceptanceCriteria: string[];
  risks: string[];
  branchName: string;
}

// ---------- Queue ----------
export interface JobPayloadMap {
  semantic_index: { repoId: number; branch: string; commitSha: string };
  pr_review: { repoId: number; prId: number };
  qa_answer: { repoId: number; branch: string; question: string; askerId: number | null };
  intent_plan: { repoId: number; intentId: number };
  preview_build: { repoId: number; prId: number; commitSha: string; branch: string };
}

export type JobPayload<T extends keyof JobPayloadMap> = JobPayloadMap[T];

// ---------- API shapes ----------
export interface RepoSummary {
  id: number;
  orgSlug: string;
  name: string;
  description: string | null;
  visibility: Visibility;
  defaultBranch: string;
  openPrCount: number;
  openIntentCount: number;
  updatedAt: string | null;
}

export interface PrSummary {
  id: number;
  number: number;
  repoId: number;
  title: string;
  status: PrStatus;
  baseBranch: string;
  headBranch: string;
  riskScore: number | null;
  riskSummary: string | null;
  authorHandle: string;
  authorName: string;
  createdAt: string;
  headSha: string | null;
}

export interface IntentSummary {
  id: number;
  number: number;
  repoId: number;
  title: string;
  status: IntentStatus;
  kind: IntentKind;
  authorHandle: string;
  labels: string[];
  branchName: string | null;
  linkedPrId: number | null;
  hasPlan: boolean;
  createdAt: string;
}

export interface PatCreated {
  id: number;
  name: string;
  token: string; // shown exactly once
  prefix: string;
}

export interface SshKeyInfo {
  id: number;
  title: string;
  fingerprint: string;
  createdAt: string;
}

// ---------- Webhooks ----------

export interface WebhookSummary {
  id: number;
  url: string;
  events: WebhookEventName[];
  active: boolean;
  createdAt: string;
}

export interface WebhookDeliverySummary {
  id: number;
  webhookId: number;
  event: string;
  status: "pending" | "delivered" | "failed";
  responseStatus: number | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}

/** Payload shape delivered to webhook endpoints (HMAC-SHA256 signed). */
export interface WebhookPayload {
  event: WebhookEventName;
  repository: { org: string; name: string; visibility: Visibility };
  sender?: { handle: string; name: string } | null;
  ref?: string;
  commits?: Array<{ sha: string; message: string; author: string }>;
  pullRequest?: { number: number; title: string; base: string; head: string; status: PrStatus };
  release?: { tag: string; name: string; targetSha: string };
}
