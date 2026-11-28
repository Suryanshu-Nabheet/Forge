// GET /raw/[org]/[repo]/[[...path]]?ref=<branch> — serve a file blob at a
// ref with its real content type: image display, downloads, permalinks.
// Visibility-gated like every other read surface.

import { NextResponse } from "next/server";
import { revParse } from "@forge/git";
import { findVisibleRepo } from "@/server/authz";
import { listBranchesDb } from "@/server/api";
import { repoGitDir } from "@forge/git";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const MAX_RAW_BYTES = 5 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  svg: "image/svg+xml", webp: "image/webp", ico: "image/x-icon",
  pdf: "application/pdf", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8",
  json: "application/json", csv: "text/csv", ts: "text/plain; charset=utf-8",
  tsx: "text/plain; charset=utf-8", js: "text/plain; charset=utf-8",
  css: "text/css",
  // SECURITY: html is forced to text/plain. Serving attacker-controlled
  // HTML same-origin (or SVG on direct navigation) executes script in the
  // Forge origin — session-bearing APIs become callable as the victim.
  // SVG keeps its type only because <img src=...> embedding cannot script
  // AND every raw response carries a sandboxing CSP below.
  html: "text/plain; charset=utf-8",
};

export async function GET(req: Request, { params }: { params: Promise<{ org: string; repo: string; path?: string[] }> }) {
  const { org, repo, path } = await params;
  const filePath = (path ?? []).join("/");
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  const url = new URL(req.url);
  const ref = url.searchParams.get("ref");

  const info = await findVisibleRepo(org, repo);
  if (!info) return NextResponse.json({ error: "not found" }, { status: 404 });

  const branches = await listBranchesDb(info.repoId);
  const branch = ref && branches.includes(ref) ? ref : info.defaultBranch;
  const gitDir = repoGitDir(org, repo);

  const commitSha = await revParse(gitDir, branch);
  if (!commitSha) return NextResponse.json({ error: "empty repository" }, { status: 404 });
  const blobSha = await revParse(gitDir, `${commitSha}:${filePath}`);
  if (!blobSha) return NextResponse.json({ error: "file not found" }, { status: 404 });

  // Read the blob as a buffer (binary-safe, unlike catFileText).
  let buf: Buffer;
  try {
    const { stdout } = await exec(
      "git",
      ["--git-dir", gitDir, "cat-file", "-p", blobSha],
      { maxBuffer: MAX_RAW_BYTES + 4096, encoding: "buffer" },
    );
    buf = stdout;
  } catch {
    return NextResponse.json({ error: "file too large" }, { status: 413 });
  }
  if (buf.byteLength > MAX_RAW_BYTES) {
    return NextResponse.json({ error: "file too large" }, { status: 413 });
  }

  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
  const inline = url.searchParams.get("download") !== "1";

  const safeName = (filePath.split("/").pop() ?? "file").replace(/["\\]/g, "_");
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(buf.byteLength),
      // Content-addressed by (ref, path): short shared caching is safe and
      // lets images/permalinks load fast without re-reading git.
      "Cache-Control": "private, max-age=60",
      // SECURITY: neutralize any active content no matter its type. `sandbox`
      // makes the document an opaque origin (no script execution, no same-
      // origin access) — belt and braces for svg, defense for anything we
      // failed to classify.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; media-src 'none'; img-src data:; sandbox",
      ...(inline ? {} : { "Content-Disposition": `attachment; filename="${safeName}"` }),
    },
  });
}
