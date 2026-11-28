import { findVisibleRepo } from "@/server/authz";
import { repoSocial, forkParent } from "@/server/api";
import { currentUser } from "@/server/session";
import { RepoSocialButtons } from "@/components/RepoSocialButtons";

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
  const user = await currentUser();
  const [social, forkedFrom] = await Promise.all([
    repoSocial(info.repoId, user?.id ?? null),
    forkParent(info.repoId),
  ]);
  return (
    <div>
      <div className="mb-5">
        <div className="flex items-baseline gap-2 flex-wrap">
          <h1 className="text-lg">
            <a href={`/${org}`} className="text-[var(--text-dim)] hover:text-[var(--text)]">{org}</a>
            <span className="text-[var(--text-faint)]"> / </span>
            <a href={`/${org}/${repo}`} className="font-semibold">{repo}</a>
          </h1>
          <span className="text-[10px] uppercase tracking-wide border border-[var(--border-strong)] rounded-full px-1.5 py-px text-[var(--text-faint)]">
            {info.visibility}
          </span>
          <span className="flex-1" />
          <RepoSocialButtons
            org={org}
            repo={repo}
            social={social}
            signedIn={user !== null}
            forkedFrom={forkedFrom ? `${forkedFrom.orgSlug}/${forkedFrom.name}` : null}
          />
        </div>
        {forkedFrom && (
          <p className="text-[12px] text-[var(--text-faint)] mt-1">
            forked from{" "}
            <a className="text-[var(--accent)]" href={`/${forkedFrom.orgSlug}/${forkedFrom.name}`}>
              {forkedFrom.orgSlug}/{forkedFrom.name}
            </a>
          </p>
        )}
        {info.description && <p className="text-[13px] text-[var(--text-dim)] mt-1">{info.description}</p>}
        <nav className="flex gap-1 mt-3 text-[13px]">
          <RepoTab org={org} repo={repo} tab="">Code</RepoTab>
          <RepoTab org={org} repo={repo} tab="commits">Commits</RepoTab>
          <RepoTab org={org} repo={repo} tab="pulls">Pull requests</RepoTab>
          <RepoTab org={org} repo={repo} tab="releases">Releases</RepoTab>
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
