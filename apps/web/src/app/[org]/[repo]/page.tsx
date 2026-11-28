import { findVisibleRepo } from "@/server/authz";
import { listBranchesDb, resolveBranchSha, repoTree, repoBlob, repoCommits } from "@/server/api";
import { repoGitDir } from "@forge/git";
import Link from "next/link";

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

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
      {/* left: branch + tree */}
      <section className="lg:col-span-3">
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <BranchSwitcher org={org} repo={repo} branch={branch} branches={branches} />
          <span className="text-xs text-[var(--text-faint)] mono">{sha?.slice(0, 7) ?? "empty"}</span>
          <span className="flex-1" />
          <span className="text-xs text-[var(--text-faint)] mono">
            git clone http://localhost:3000/git/{org}/{repo}.git
          </span>
        </div>

        {isFile && blob ? (
          <FileView path={treePath} blob={blob} />
        ) : (
          <div className="card divide-y">
            {treePath && <UpDir org={org} repo={repo} branch={branch} treePath={treePath} />}
            {entries.length === 0 && (
              <div className="px-4 py-8 text-center text-[var(--text-dim)] text-[13px]">
                Empty repository — push your first commit.
              </div>
            )}
            {entries.map((e) => (
              <TreeRow key={e.path} org={org} repo={repo} branch={branch} entry={e} treePath={treePath} />
            ))}
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

function FileView({ path, blob }: { path: string; blob: { content: string | null; isBinary: boolean } }) {
  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-2 border-b text-[13px] mono text-[var(--text-dim)]">{path}</div>
      {blob.isBinary ? (
        <div className="px-4 py-8 text-center text-[var(--text-dim)] text-[13px]">Binary file</div>
      ) : blob.content === null ? (
        <div className="px-4 py-8 text-center text-[var(--text-dim)] text-[13px]">File too large to display</div>
      ) : (
        <pre className="overflow-x-auto p-4 text-[12.5px] mono leading-relaxed" style={{ maxHeight: "70vh" }}>
          {blob.content}
        </pre>
      )}
    </div>
  );
}
