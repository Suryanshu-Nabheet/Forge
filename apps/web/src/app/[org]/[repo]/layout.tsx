import { findVisibleRepo } from "@/server/authz";

export default async function RepoLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string; repo: string }>;
}) {
  const { org, repo } = await params;
  const info = await findVisibleRepo(org, repo);
  if (!info) {
    return <div className="p-8 text-center text-[var(--text-dim)]">Repository not found: {org}/{repo}</div>;
  }
  return (
    <div>
      <div className="mb-5">
        <div className="flex items-baseline gap-2">
          <h1 className="text-lg">
            <a href={`/${org}`} className="text-[var(--text-dim)] hover:text-[var(--text)]">{org}</a>
            <span className="text-[var(--text-faint)]"> / </span>
            <a href={`/${org}/${repo}`} className="font-semibold">{repo}</a>
          </h1>
          <span className="text-[10px] uppercase tracking-wide border border-[var(--border-strong)] rounded-full px-1.5 py-px text-[var(--text-faint)]">
            {info.visibility}
          </span>
        </div>
        {info.description && <p className="text-[13px] text-[var(--text-dim)] mt-1">{info.description}</p>}
        <nav className="flex gap-1 mt-3 text-[13px]">
          <RepoTab org={org} repo={repo} tab="">Code</RepoTab>
          <RepoTab org={org} repo={repo} tab="pulls">Pull requests</RepoTab>
          <RepoTab org={org} repo={repo} tab="issues">Intents</RepoTab>
          <RepoTab org={org} repo={repo} tab="ask">Ask AI</RepoTab>
          <RepoTab org={org} repo={repo} tab="settings">Settings</RepoTab>
        </nav>
      </div>
      {children}
    </div>
  );
}

function RepoTab({ org, repo, tab, children }: { org: string; repo: string; tab: string; children: React.ReactNode }) {
  const href = tab ? `/${org}/${repo}/${tab}` : `/${org}/${repo}`;
  return (
    <a href={href} className="px-3 py-1.5 rounded-md text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)] transition-colors">
      {children}
    </a>
  );
}
