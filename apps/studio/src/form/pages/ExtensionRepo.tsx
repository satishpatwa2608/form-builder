import { useState } from 'react';
import { format } from 'date-fns';
import { Copy, GitBranch, Link2, Rocket, ShieldCheck, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@ui/button';
import { messageOf } from '../adapters/backend';
import { buildUnderWay, useRepo, useRepoBranches, useRepoChange, type ExtensionBuildRow, type RepoView } from '../adapters/extensions';

const STATE: Record<ExtensionBuildRow['status'], string> = { BUILDING: 'Building', DEPLOYING: 'Deploying', LIVE: 'Running', FAILED: 'Failed' };
const HOST: Record<string, { name: string; key: string; hook: string }> = {
  'github.com': { name: 'GitHub', key: 'Settings → Deploy keys → Add deploy key (leave "Allow write access" off)', hook: 'Settings → Webhooks → Add webhook. Content type: application/json. Events: just the push event' },
  'gitlab.com': { name: 'GitLab', key: 'Settings → Repository → Deploy keys', hook: 'Settings → Webhooks, with "Push events" ticked' },
  'bitbucket.org': { name: 'Bitbucket', key: 'Repository settings → Access keys', hook: 'Repository settings → Webhooks, triggered by "Repository push"' },
};

function Copyable({ label, text }: { label: string; text: string }) {
  return (
    <div className="fb-command">
      <code aria-label={label}>{text}</code>
      <Button type="button" variant="outline" size="sm" aria-label={`Copy: ${label}`} onClick={() => void navigator.clipboard.writeText(text).then(() => toast.success('Copied'))}>
        <Copy /> Copy
      </Button>
    </div>
  );
}

function Builds({ builds }: { builds: ExtensionBuildRow[] }) {
  if (!builds.length) return null;
  return (
    <div className="space-y-2">
      <div className="fb-panel__title">Builds</div>
      <div style={{ overflowX: 'auto' }}>
        <table className="fb-builds" aria-label="Builds">
          <thead>
            <tr>
              <th>When</th>
              <th>Started by</th>
              <th>Branch</th>
              <th>Commit</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {builds.map((b) => (
              <tr key={b.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{b.at ? format(new Date(b.at), 'dd MMM, HH:mm') : 'Just now'}</td>
                <td>{b.trigger === 'COMMIT' ? 'A commit' : 'Deploy now'}</td>
                <td>{b.branch}</td>
                <td>
                  {b.commit && <code>{b.commit}</code>} {b.commitMessage}
                </td>
                <td>
                  <span className="fb-extension__status" data-status={b.status === 'FAILED' ? 'UNREACHABLE' : b.status === 'LIVE' ? 'OK' : undefined}>
                    {STATE[b.status]}
                  </span>
                  {b.message && <div className="fb-muted">{b.message}</div>}
                  {b.output && (
                    <details>
                      <summary className="fb-muted">What was printed</summary>
                      <pre className="fb-command__output">{b.output}</pre>
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Linked({ view }: { view: RepoView & { repo: NonNullable<RepoView['repo']> } }) {
  const { repo } = view;
  const change = useRepoChange();
  const branches = useRepoBranches(true);
  const host = HOST[repo.host] ?? HOST['github.com']!;
  const busy = change.isPending || buildUnderWay(view);
  const ask = (what: Parameters<typeof change.mutateAsync>[0], done?: string) =>
    void change
      .mutateAsync(what)
      .then(() => done && toast.success(done))
      .catch((e) => toast.error(messageOf(e)));
  const canRead = !!branches.data;
  // The branch that is deployed stays in the list even if the repository no longer has it.
  const options = [...new Set([repo.branch, ...(branches.data ?? [])])];

  return (
    <>
      <p>
        <Link2 size={14} style={{ display: 'inline', verticalAlign: '-2px' }} />{' '}
        <a href={repo.url} target="_blank" rel="noopener noreferrer">
          {repo.url}
        </a>
      </p>

      <div className="space-y-2">
        <div className="fb-panel__title">1. Let Form Builder read the code</div>
        {canRead ? (
          <p className="fb-muted">
            <ShieldCheck size={14} style={{ display: 'inline', verticalAlign: '-2px', color: '#15803d' }} /> Form Builder can read the repository.
          </p>
        ) : (
          <>
            <p className="fb-muted">
              Add this key to the repository in {host.name}: {host.key}. It can read this one repository and change nothing.
            </p>
            <Copyable label="Key to add to the repository" text={repo.publicKey} />
            {branches.isError && <p className="fb-issues">{messageOf(branches.error)}</p>}
            <Button type="button" variant="outline" disabled={branches.isFetching} onClick={() => void branches.refetch()}>
              <ShieldCheck /> I have added it: check
            </Button>
          </>
        )}
      </div>

      <div className="space-y-2">
        <div className="fb-panel__title">2. What to deploy</div>
        <label className="fb-field" style={{ maxWidth: 420 }}>
          <span className="fb-field__label">Branch</span>
          <select className="fb-input" value={repo.branch} disabled={busy || !canRead} onChange={(e) => ask({ branch: e.target.value }, `Deploying from ${e.target.value}`)}>
            {options.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={repo.auto} disabled={change.isPending} onChange={(e) => ask({ auto: e.target.checked }, e.target.checked ? 'Every commit to the branch will be deployed' : 'Commits are no longer deployed by themselves')} />
          <span>Deploy on every commit to this branch</span>
        </label>
        {repo.auto && (
          <>
            <p className="fb-muted">
              So that {host.name} tells Form Builder when the branch changes, add this address in {host.name}: {host.hook}. Keep it to yourselves: anyone who has it can start a build of your branch.
            </p>
            <Copyable label="Address to call when the code changes" text={repo.hookUrl} />
          </>
        )}
      </div>

      <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
        <Button type="button" disabled={busy || !canRead} onClick={() => ask('build', `Building ${repo.branch}`)}>
          <Rocket /> Deploy now
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={change.isPending}
          onClick={() => window.confirm('Unlink the repository? What is running keeps running; the key and the address stop working.') && ask('unlink', 'The repository is no longer linked')}
        >
          <Unlink /> Unlink
        </Button>
      </div>
    </>
  );
}

/**
 * An organisation's extension built straight from its repository: link it, choose the branch, and deploy by
 * pressing a button or on every commit. Shown only where the installation offers it.
 */
export function ExtensionRepo() {
  const { data: view } = useRepo();
  const change = useRepoChange();
  const [url, setUrl] = useState('');
  if (!view?.available) return null;

  return (
    <section className="fb-extension" aria-label="Deploy from your repository">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">
          <GitBranch size={18} style={{ display: 'inline', verticalAlign: '-3px' }} /> Deploy from your repository
        </h2>
        <p className="fb-muted">
          Link the repository your extension is kept in. Form Builder builds the branch you choose and deploys it, when you press Deploy now or on every commit. Nothing to install: no Docker, no
          commands.
        </p>
      </div>
      {view.repo ? (
        <Linked view={{ ...view, repo: view.repo }} />
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void change.mutateAsync({ link: url }).catch((err) => toast.error(messageOf(err)));
          }}
        >
          <label className="fb-field" style={{ maxWidth: 560 }}>
            <span className="fb-field__label">Repository address</span>
            <input className="fb-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/your-company/your-extension" />
          </label>
          <Button type="submit" disabled={change.isPending || !url.trim()}>
            <Link2 /> Link the repository
          </Button>
        </form>
      )}
      <Builds builds={view.builds} />
    </section>
  );
}
