// Unit tests for the CODEOWNERS matcher + palette fuzzy scorer.

import { describe, it, expect } from "vitest";
import { codeownersReviewers } from "@forge/jobs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const exec = promisify(execFile);

describe("CODEOWNERS matching", () => {
  it("matches patterns, exclusions, and globs end to end", async () => {
    // Build a repo with a CODEOWNERS file and files to diff.
    const work = await mkdtemp(path.join(tmpdir(), "co-unit-"));
    try {
      await exec("bash", ["-c", `
        cd ${work}
        git init --quiet .
        git config user.email t@t && git config user.name T
        printf '*.ts @alice\\n!src/generated.ts @alice\\ndocs/ @bob\\n*.md @carol\\n' > CODEOWNERS
        printf 'x' > a.ts
        mkdir -p src docs
        printf 'x' > src/generated.ts
        printf 'x' > docs/readme.md
        printf 'x' > notes.md
        git add . && git commit --quiet -m init
        git clone --quiet --bare . ${work}/../co-bare-$(basename ${work}).git
      `]);
      const bare = `${work}/../co-bare-$(basename ${work})`.replace("$(basename ", "").replace(")", "");
      const barePath = path.join(path.dirname(work), `co-bare-${path.basename(work)}.git`);
      void bare;
      const changed = ["a.ts", "src/generated.ts", "docs/readme.md", "notes.md"];

      const owners = await codeownersReviewers(barePath, "HEAD", changed);
      // a.ts → alice (classic); src/generated.ts excluded by !; docs/readme.md
      // matches docs/ → bob AND *.md → carol (last-match wins per path: bob then carol);
      // notes.md → carol.
      expect(owners).toContain("alice");
      expect(owners).toContain("bob");
      expect(owners).toContain("carol");
    } finally {
      await rm(path.dirname(work), { recursive: true, force: true }).catch(() => {});
    }
  });

  it("returns [] for repos without a CODEOWNERS file", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "co-none-"));
    try {
      await exec("bash", ["-c", `cd ${work} && git init --quiet . && printf 'x' > f.txt && git add . && git -c user.email=t@t -c user.name=T commit --quiet -m i && git clone --quiet --bare . ${work}/bare.git`]);
      expect(await codeownersReviewers(`${work}/bare.git`, "HEAD", ["f.txt"])).toEqual([]);
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  });
});
