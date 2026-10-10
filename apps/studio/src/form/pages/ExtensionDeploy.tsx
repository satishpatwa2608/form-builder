import { useState } from 'react';
import { format } from 'date-fns';
import { Copy, KeyRound, RefreshCw, Rocket, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@ui/button';
import { messageOf } from '../adapters/backend';
import { deployUnderWay, useDeployKey, useDeployStatus, usePushedImages, usePushLogin, useRequestDeploy, type DeployStatus, type ExtensionDeployRow, type PushLogin } from '../adapters/extensions';

const STATE: Record<ExtensionDeployRow['status'], string> = { PENDING: 'Waiting to start', RUNNING: 'Deploying', LIVE: 'Running', FAILED: 'Failed', REMOVED: 'Removed' };

function Command({ label, text, secret }: { label: string; text: string; secret?: string }) {
  return (
    <div className="fb-command">
      <code aria-label={label}>{secret ? text.replace(secret, '••••••••') : text}</code>
      <Button type="button" variant="outline" size="sm" aria-label={`Copy: ${label}`} onClick={() => void navigator.clipboard.writeText(text).then(() => toast.success('Copied'))}>
        <Copy /> Copy
      </Button>
    </div>
  );
}

function PushCommands({ login }: { login: PushLogin }) {
  return (
    <div className="space-y-2" aria-label="Push commands">
      <p className="fb-muted">
        Run these where your code is, with Docker installed. The sign-in works until {format(new Date(login.expiresAt), 'HH:mm')} and only for your organisation's own image space; it is not shown again.
        Give each version a name of its own (v1, v2, …).
      </p>
      <Command label="Sign in to your image space" text={`docker login ${login.registry} -u ${login.username} -p ${login.password}`} secret={login.password} />
      <Command label="Build" text={`docker build --platform ${login.platform} -t ${login.image}:v1 .`} />
      <Command label="Push" text={`docker push ${login.image}:v1`} />
    </div>
  );
}

/** For teams that deploy on every commit: a key their pipeline keeps, in place of someone pressing the buttons above. */
function PipelineKey({ status }: { status: DeployStatus }) {
  const key = useDeployKey();
  const [shown, setShown] = useState('');
  const make = () =>
    void key
      .mutateAsync(true)
      .then((r) => setShown(r.newKey ?? ''))
      .catch((e) => toast.error(messageOf(e)));
  return (
    <div className="space-y-2" aria-label="Deploy from your pipeline">
      <div className="fb-panel__title">3. Or deploy on every commit (optional)</div>
      <p className="fb-muted">
        A pipeline such as GitHub Actions can push and deploy by itself. Give it a deploy key: it can push to your image space and deploy your extension, and nothing else. The starter kit has a
        workflow to copy (pipeline-examples); it needs this key as the secret <code>FB_DEPLOY_KEY</code>
        {status.api && (
          <>
            {' '}
            and this address as the variable <code>FB_API_URL</code>: <code>{status.api}</code>
          </>
        )}
        .
      </p>
      {shown && (
        <>
          <p className="fb-muted">Copy it now: it is not shown again.</p>
          <Command label="Deploy key" text={shown} secret={shown.slice(8)} />
        </>
      )}
      {status.key && !shown && (
        <p className="fb-muted">
          A key ending in <code>{status.key.hint}</code> is in use{status.key.lastUsedAt ? `, last on ${format(new Date(status.key.lastUsedAt), 'dd MMM, HH:mm')}` : ', and has not been used yet'}.
        </p>
      )}
      <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
        <Button
          type="button"
          variant="outline"
          disabled={key.isPending}
          onClick={() => (!status.key || window.confirm('Make a new deploy key? The one in use stops working at once, and your pipeline needs the new one.')) && make()}
        >
          <KeyRound /> {status.key ? 'Make a new deploy key' : 'Make a deploy key'}
        </Button>
        {status.key && (
          <Button
            type="button"
            variant="outline"
            disabled={key.isPending}
            onClick={() =>
              window.confirm('Take the deploy key back? Your pipeline will no longer be able to deploy.') &&
              void key
                .mutateAsync(false)
                .then(() => {
                  setShown('');
                  toast.success('The deploy key no longer works');
                })
                .catch((e) => toast.error(messageOf(e)))
            }
          >
            <Trash2 /> Take the key back
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * An organisation deploying its own code by itself: push an image to its own space, choose the version, Deploy.
 * Shown only where the installation offers it; elsewhere the page says we deploy it for them.
 */
export function ExtensionDeploy({ running }: { running: boolean }) {
  const { data: status } = useDeployStatus();
  const login = usePushLogin();
  const request = useRequestDeploy();
  const [asked, setAsked] = useState(false);
  const images = usePushedImages(!!status?.available && status.included);
  const [chosen, setChosen] = useState('');
  if (!status?.available) return null;

  const busy = deployUnderWay(status) || request.isPending;
  const tag = chosen || images.data?.[0]?.tag || '';
  const last = status.deploys[0];

  return (
    <section className="fb-extension" aria-label="Deploy your own code">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Or build it yourselves</h2>
        <p className="fb-muted">
          For teams that would rather build the image on their own machines or pipeline. Your developers build the extension as a Docker image and push it to your organisation's own image space. You choose the version and press Deploy: it runs beside Form Builder, for your
          organisation only, and what it offers appears in the builder. A version that does not start changes nothing: the one before keeps running.
        </p>
      </div>
      {!status.included ? (
        <div className="fb-banner">Your plan does not include extensions.</div>
      ) : (
        <>
          <div className="space-y-2">
            <div className="fb-panel__title">1. Push a version</div>
            {login.data && asked ? (
              <PushCommands login={login.data} />
            ) : (
              <Button
                type="button"
                variant="outline"
                disabled={login.isPending}
                onClick={() =>
                  void login
                    .mutateAsync()
                    .then(() => setAsked(true))
                    .catch((e) => toast.error(messageOf(e)))
                }
              >
                <KeyRound /> Show the push commands
              </Button>
            )}
          </div>

          <div className="space-y-2">
            <div className="fb-panel__title">2. Choose the version and deploy</div>
            {images.data && !images.data.length ? (
              <p className="fb-muted">Nothing has been pushed yet.</p>
            ) : (
              <label className="fb-field" style={{ maxWidth: 420 }}>
                <span className="fb-field__label">Version</span>
                <select className="fb-input" value={tag} onChange={(e) => setChosen(e.target.value)} disabled={busy}>
                  {(images.data ?? []).map((i) => (
                    <option key={i.tag} value={i.tag}>
                      {i.tag}
                      {i.pushedAt ? ` · pushed ${format(new Date(i.pushedAt), 'dd MMM, HH:mm')}` : ''} · {i.sizeMb} MB
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
              <Button
                type="button"
                disabled={busy || !tag}
                onClick={() =>
                  void request
                    .mutateAsync(tag)
                    .then(() => toast.success(`Deploying ${tag}`))
                    .catch((e) => toast.error(messageOf(e)))
                }
              >
                <Rocket /> Deploy
              </Button>
              <Button type="button" variant="outline" disabled={images.isFetching} onClick={() => void images.refetch()}>
                <RefreshCw /> Look again for pushed versions
              </Button>
              {running && (
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={() =>
                    window.confirm('Remove your extension? Its steps, lists and checks stop being offered, and forms that use them must be changed before they can be published again.') &&
                    void request
                      .mutateAsync(null)
                      .then(() => toast.success('Removing the extension'))
                      .catch((e) => toast.error(messageOf(e)))
                  }
                >
                  <Trash2 /> Remove the extension
                </Button>
              )}
            </div>
          </div>

          <PipelineKey status={status} />

          {last && (
            <div className="space-y-2" aria-label="Latest deployment" role="status">
              <div className="fb-panel__title">Latest</div>
              <p>
                <span className="fb-extension__status" data-status={last.status === 'FAILED' ? 'UNREACHABLE' : last.status === 'LIVE' ? 'OK' : undefined}>
                  {STATE[last.status]}
                </span>
                {last.tag && ` · version ${last.tag}`}
                {last.at && ` · asked ${format(new Date(last.at), 'dd MMM, HH:mm')}`}
              </p>
              {last.message && <p className={last.status === 'FAILED' ? 'fb-issues' : 'fb-muted'}>{last.message}</p>}
              {last.output && (
                <details>
                  <summary className="fb-muted">What your code printed</summary>
                  <pre className="fb-command__output">{last.output}</pre>
                </details>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
