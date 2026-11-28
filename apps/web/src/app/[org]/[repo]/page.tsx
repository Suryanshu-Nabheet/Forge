import { findVisibleRepo } from "@/server/authz";
import { listBranchesDb, resolveBranchSha, repoTree, repoBlob, repoCommits } from "@/server/api";
import { repoGitDir } from "@forge/git";
import Link from "next/link";
import { Markdown } from "@/components/Markdown";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ org: string; repo: string }>;
  searchParams: Promise<{ ref?: string; path?: string }>;
}

export default async function CodePage({ params, searchParams }: PageProps) {
  const { org, repo } = await params;
  const { ref: branchParam, path: pathParam } = await searchParams;
  const info = await findVisibleRepo(org, repo);
  if (!info) return <div className="text-[var(--text-dim)]">not found</div>;
  const gitDir = repoGitDir(org, repo);

  const branches = await listBranchesDb(info.repoId);
  const branch = branchParam && branches.includes(branchParam) ? branchParam : info.defaultBranch;
  const sha = await resolveBranchSha(gitDir, branch, info.defaultBranch);
  const treePath = pathParam ?? "";

  // A path may point at a file — try blob resolution before listing the tree.
  const fileBlob = treePath && sha ? await repoBlob(gitDir, sha, treePath) : null;
  const isFile = fileBlob !== null;
  const entries = !isFile && sha ? await repoTree(gitDir, sha, treePath) : [];
  const commits = sha ? await repoCommits(gitDir, sha, 10) : [];
  const blob = fileBlob;

  // README panel: find a README* entry in this directory and render it.
  const readmeEntry = entries.find((e) => /^readme(\.\w+)?$/i.test(e.path.split("/").pop() ?? ""));
  let readme: { path: string; content: string } | null = null;
  if (!isFile && readmeEntry && sha) {
    const content = await repoBlob(gitDir, sha, treePath ? `${treePath}/${readmeEntry.path}` : readmeEntry.path);
    if (content && !content.isBinary && content.content) {
      readme = { path: readmeEntry.path, content: content.content };
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
      {/* left: branch + tree */}
      <section className="lg:col-span-3">
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <BranchSwitcher org={org} repo={repo} branch={branch} branches={branches} />
          <span className="text-xs text-[var(--text-faint)] mono">{sha?.slice(0, 7) ?? "empty"}</span>
          <span className="flex-1" />
          <span className="text-xs text-[var(--text-faint)] mono">
            git clone {cloneBase()}/git/{org}/{repo}.git
          </span>
        </div>

        {isFile && blob ? (
          <FileView org={org} repo={repo} branch={branch} sha={sha} path={treePath} blob={blob} />
        ) : (
          <div className="card divide-y">
            {treePath && <UpDir org={org} repo={repo} branch={branch} treePath={treePath} />}
            {entries.length === 0 && !treePath && (
              <div className="px-6 py-6 text-[13px] space-y-3">
                <div className="text-[var(--text-dim)]">
                  Empty repository. Push your first commit:
                </div>
                <pre className="mono text-[12px] p-3 rounded border bg-[var(--bg)] overflow-x-auto">{[
                  "git init",
                  `git remote add origin ${cloneBase()}/git/${org}/${repo}.git`,
                  'echo "# ' + repo + '" > README.md',
                  "git add . && git commit -m \"first commit\"",
                  "git push -u origin main",
                ].join("\n")}</pre>
              </div>
            )}
            {entries.map((e) => (
              <TreeRow key={e.path} org={org} repo={repo} branch={branch} entry={e} treePath={treePath} />
            ))}
          </div>
        )}

        {readme && (
          <div className="card mt-5 overflow-hidden">
            <div className="px-4 py-2 border-b text-[13px] mono text-[var(--text-dim)]">{readme.path}</div>
            <div className="p-4 text-[13px] leading-relaxed">
              <Markdown text={readme.content} />
            </div>
          </div>
        )}

        <h2 className="text-base font-semibold mt-6 mb-2">Recent commits</h2>
        <div className="card divide-y">
          {commits.length === 0 && <div className="px-4 py-4 text-[13px] text-[var(--text-dim)]">No commits yet.</div>}
          {commits.map((c) => (
            <a key={c.sha} href={`/${org}/${repo}/commits/${c.sha}`} className="block px-4 py-2.5 hover:bg-[var(--bg-hover)]">
              <div className="flex items-baseline gap-3">
                <span className="mono text-xs text-[var(--accent)] shrink-0">{c.sha.slice(0, 7)}</span>
                <span className="text-[13px] truncate flex-1">{c.message}</span>
                <span className="text-xs text-[var(--text-faint)] shrink-0">{c.authorName}</span>
              </div>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}

function BranchSwitcher({ org, repo, branch, branches }: { org: string; repo: string; branch: string; branches: string[] }) {
  return (
    <form action={`/${org}/${repo}`} method="get" className="flex items-center gap-2">
      <label className="text-xs text-[var(--text-faint)]">branch</label>
      <select name="ref" defaultValue={branch} className="input" style={{ width: "auto" }}>
        {(branches.length ? branches : [branch]).map((b) => (
          <option key={b} value={b}>{b}</option>
        ))}
      </select>
      <button type="submit" className="btn px-2 py-1 text-xs">Go</button>
    </form>
  );
}

function UpDir({ org, repo, branch, treePath }: { org: string; repo: string; branch: string; treePath: string }) {
  const parent = treePath.split("/").slice(0, -1).join("/");
  const href = `/${org}/${repo}?ref=${encodeURIComponent(branch)}${parent ? `&path=${encodeURIComponent(parent)}` : ""}`;
  return (
    <a href={href} className="block px-4 py-2 text-[13px] mono text-[var(--text-dim)] hover:bg-[var(--bg-hover)]">
      ../
    </a>
  );
}

function TreeRow({ org, repo, branch, entry, treePath }: {
  org: string; repo: string; branch: string; entry: { path: string; type: string; size?: number }; treePath: string;
}) {
  const name = entry.path;
  const isTree = entry.type === "tree";
  const childPath = treePath ? `${treePath}/${name}` : name;
  const href = `/${org}/${repo}?ref=${encodeURIComponent(branch)}&path=${encodeURIComponent(childPath)}`;
  return (
    <div className="flex items-center px-4 py-2 text-[13px] hover:bg-[var(--bg-hover)]">
      <span className="mr-2.5 w-4 text-center">{isTree ? "📁" : "📄"}</span>
      <a href={href} className="flex-1">{name}</a>
      {entry.size !== undefined && (
        <span className="text-xs text-[var(--text-faint)] mono">{entry.size > 1024 ? `${Math.round(entry.size / 1024)} KB` : `${entry.size} B`}</span>
      )}
    </div>
  );
}

function FileView({ org, repo, branch, sha, path, blob }: {
  org: string; repo: string; branch: string; sha: string | null;
  path: string; blob: { content: string | null; isBinary: boolean };
}) {
  const rawUrl = `/raw/${org}/${repo}/${path}?ref=${encodeURIComponent(branch)}`;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const isImage = ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext);
  const isMarkdown = ext === "md" || ext === "markdown";
  const lines = blob.content ? blob.content.split("\n") : [];
  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-2 border-b flex items-center gap-3 flex-wrap">
        <span className="text-[13px] mono text-[var(--text-dim)] flex-1">{path}</span>
        {isMarkdown && blob.content && (
          <a className="btn px-2 py-0.5 text-xs" href={rawUrl}>Raw</a>
        )}
        <a className="btn px-2 py-0.5 text-xs" href={`${rawUrl}&download=1`}>Download</a>
        {sha && (
          <a className="btn px-2 py-0.5 text-xs" title="Permalink to this file at this commit"
            href={`/${org}/${repo}/blame/${path}?ref=${encodeURIComponent(branch)}`}>Blame</a>
        )}
      </div>
      {isImage ? (
        <div className="p-6 flex justify-center bg-[var(--bg)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={rawUrl} alt={path} className="max-h-[70vh] rounded border" />
        </div>
      ) : blob.isBinary ? (
        <div className="px-4 py-8 text-center text-[var(--text-dim)] text-[13px]">
          Binary file — <a className="text-[var(--accent)]" href={`${rawUrl}&download=1`}>download</a>
        </div>
      ) : blob.content === null ? (
        <div className="px-4 py-8 text-center text-[var(--text-dim)] text-[13px]">File too large to display</div>
      ) : isMarkdown ? (
        <div className="p-4 text-[13px] leading-relaxed">
          <Markdown text={blob.content} />
        </div>
      ) : (
        <pre className="overflow-x-auto p-4 text-[12.5px] mono leading-relaxed" style={{ maxHeight: "70vh" }}>
          {lines.map((content, i) => (
            <span key={i} id={`L${i + 1}`} className="block hover:bg-[var(--bg-hover)] group">
              <span className="inline-block w-10 pr-2 mr-3 text-right text-[var(--text-faint)] select-none border-r group-hover:text-[var(--accent)]">
                {i + 1}
              </span>
              {content || " "}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

function cloneBase(): string {
  return (process.env.FORGE_EXTERNAL_URL ?? "http://localhost:3000").replace(/\/$/, "");
}
