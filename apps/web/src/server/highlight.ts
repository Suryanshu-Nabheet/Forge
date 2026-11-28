// Server-side syntax highlighting (shiki) with a singleton highlighter.
// Shiki is sync-capable after first load; themes are the dual dark/light
// pair so highlighted blocks match the app theme.

import { createHighlighter, type Highlighter } from "shiki";

let highlighter: Highlighter | null = null;
let loading: Promise<Highlighter> | null = null;

const LANGS = [
  "typescript", "tsx", "javascript", "jsx", "json", "css", "html", "markdown",
  "bash", "sql", "python", "go", "rust", "yaml", "diff",
];

export async function getHighlighter(): Promise<Highlighter> {
  if (highlighter) return highlighter;
  if (!loading) {
    loading = createHighlighter({ themes: ["github-dark-default"], langs: LANGS });
  }
  highlighter = await loading;
  return highlighter;
}

/** Map a file extension to a shiki language id ("" = plain). */
export function langFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
    json: "json", css: "css", scss: "css", html: "html", md: "markdown",
    sh: "bash", bash: "bash", zsh: "bash", sql: "sql",
    py: "python", go: "go", rs: "rust", yaml: "yaml", yml: "yaml",
  };
  return map[ext] ?? "";
}

/** Highlight a full file's text; returns "" if language unsupported/empty. */
export async function highlightCode(code: string, lang: string): Promise<string> {
  if (!lang) return "";
  try {
    const hi = await getHighlighter();
    return hi.codeToHtml(code, { lang, theme: "github-dark-default" });
  } catch {
    return "";
  }
}
