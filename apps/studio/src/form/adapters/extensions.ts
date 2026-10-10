import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi, unwrap, USE_API } from './backend';

/** Something an extension offers: a workflow step, a dropdown list or a check. */
export interface ExtensionOffer {
  key: string;
  label: string;
  description?: string;
  outputs?: string[];
  params?: string[];
}

/** The organisation's own code, running in its extension (see docs/extensions.md). */
export interface ExtensionInfo {
  id: string;
  ref: string;
  name: string;
  /** NEW until it has answered once. */
  status: 'NEW' | 'OK' | 'UNREACHABLE';
  lastSyncedAt: string | null;
  lastError: string;
  steps: ExtensionOffer[];
  lists: ExtensionOffer[];
  checks: ExtensionOffer[];
  fields?: ExtensionOffer[];
}

/** A check a form can run before a submission is accepted, as the form stores it. */
export interface SubmitCheck {
  key: string;
  label: string;
  description?: string;
}

/** A field the organisation's own code draws, as a form names it. */
export interface CustomFieldOffer {
  key: string;
  label: string;
  description?: string;
  height: number;
}

/** Without the API (tests, local storage only) there are no extensions unless a test seeds them. */
let local: { extensions: ExtensionInfo[]; checks: SubmitCheck[]; fields: CustomFieldOffer[] } = { extensions: [], checks: [], fields: [] };
export const seedLocalExtensions = (extensions: ExtensionInfo[], checks: SubmitCheck[] = [], fields: CustomFieldOffer[] = []) => {
  local = { extensions, checks, fields };
};

const KEY = ['form-platform', 'extensions'] as const;

/** For admins: what is installed for the organisation and what it offers. */
export function useExtensions() {
  return useQuery({ queryKey: KEY, queryFn: async () => (USE_API ? unwrap<ExtensionInfo[]>(await adminApi.get('/extensions')) : local.extensions) });
}

/** Reads again what an extension offers, after a new version of it has been deployed. */
export function useRefreshExtension() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (USE_API ? unwrap<ExtensionInfo>(await adminApi.post(`/extensions/${encodeURIComponent(id)}/refresh`)) : local.extensions.find((e) => e.id === id)!),
    onSettled: () => qc.invalidateQueries({ queryKey: ['form-platform'] }),
  });
}

/** For designers: the checks a form can switch on. */
export function useSubmitChecks() {
  return useQuery({
    queryKey: [...KEY, 'checks'],
    queryFn: async () => (USE_API ? unwrap<SubmitCheck[]>(await adminApi.get('/extensions/checks')) : local.checks),
    staleTime: 60_000,
    retry: false,
  });
}

/** For designers: the fields the organisation's own code draws. */
export function useCustomFields() {
  return useQuery({
    queryKey: [...KEY, 'fields'],
    queryFn: async () => (USE_API ? unwrap<CustomFieldOffer[]>(await adminApi.get('/extensions/fields')) : local.fields),
    staleTime: 60_000,
    retry: false,
  });
}

// ── Deploying your own code, by yourself ──────────────────────────────────

/** One request to run (or take away) a version, and how it went. */
export interface ExtensionDeployRow {
  id: string;
  kind: 'DEPLOY' | 'REMOVE';
  tag: string;
  status: 'PENDING' | 'RUNNING' | 'LIVE' | 'FAILED' | 'REMOVED';
  message: string;
  /** The end of the code's own output, when it would not start. */
  output: string;
  at: string | null;
  finishedAt: string | null;
}
export interface DeployStatus {
  /** Whether this installation lets organisations deploy their own code themselves. */
  available: boolean;
  /** Whether the organisation's plan includes extensions. */
  included: boolean;
  /** The kind of machine the code runs on: an image built for another will not start. */
  platform: string;
  /** For a pipeline: the address it calls, and the organisation's deploy key if one has been made. */
  api?: string;
  key?: { hint: string; createdAt: string | null; lastUsedAt: string | null } | null;
  deploys: ExtensionDeployRow[];
}
/** What to push with: shown once, and it stops working after an hour. */
export interface PushLogin {
  registry: string;
  image: string;
  username: string;
  password: string;
  expiresAt: string;
  platform: string;
}
export interface PushedImage {
  tag: string;
  pushedAt: string | null;
  sizeMb: number;
}

let localDeploy: { status: DeployStatus; login: PushLogin; images: PushedImage[]; asked: string[] } | undefined;
/** Tests: what the API would answer about deployments, and what gets asked of it. */
export const seedLocalDeploy = (seed?: { status: DeployStatus; login: PushLogin; images: PushedImage[] }) => {
  localDeploy = seed && { ...seed, asked: [] };
  return localDeploy;
};
const OFF: DeployStatus = { available: false, included: false, platform: 'linux/arm64', deploys: [] };
const DEPLOY = [...KEY, 'deploy'] as const;
export const deployUnderWay = (s?: DeployStatus) => !!s?.deploys.some((d) => d.status === 'PENDING' || d.status === 'RUNNING');

/** Where deployments stand. Asked again every few seconds while one is under way. */
export function useDeployStatus() {
  return useQuery({
    queryKey: DEPLOY,
    queryFn: async () => (USE_API ? unwrap<DeployStatus>(await adminApi.get('/extensions/deploy')) : (localDeploy?.status ?? OFF)),
    refetchInterval: (q) => (deployUnderWay(q.state.data) ? 3000 : false),
    retry: false,
  });
}

export function usePushLogin() {
  return useMutation({ mutationFn: async () => (USE_API ? unwrap<PushLogin>(await adminApi.post('/extensions/deploy/login')) : localDeploy!.login) });
}

export function usePushedImages(enabled: boolean) {
  return useQuery({ queryKey: [...DEPLOY, 'images'], enabled, queryFn: async () => (USE_API ? unwrap<PushedImage[]>(await adminApi.get('/extensions/deploy/images')) : (localDeploy?.images ?? [])), retry: false });
}

/** Asks for a pushed version to run, or (with no tag) for the extension to be taken away. */
export function useRequestDeploy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tag: string | null) => {
      if (!USE_API) {
        localDeploy!.asked.push(tag ?? 'REMOVE');
        localDeploy!.status = { ...localDeploy!.status, deploys: [{ id: `d${localDeploy!.asked.length}`, kind: tag ? 'DEPLOY' : 'REMOVE', tag: tag ?? '', status: 'PENDING', message: '', output: '', at: null, finishedAt: null }, ...localDeploy!.status.deploys] };
        return localDeploy!.status;
      }
      return unwrap<DeployStatus>(tag ? await adminApi.post('/extensions/deploy', { tag }) : await adminApi.delete('/extensions/deploy'));
    },
    onSuccess: (status) => qc.setQueryData(DEPLOY, status),
  });
}

/** Makes the organisation's deploy key (replacing the one before) or, with `false`, takes it back. The new key is shown once. */
export function useDeployKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (make: boolean) => {
      if (!USE_API) {
        localDeploy!.asked.push(make ? 'KEY' : 'REVOKE');
        localDeploy!.status = { ...localDeploy!.status, key: make ? { hint: 'wxyz', createdAt: null, lastUsedAt: null } : null };
        return { ...localDeploy!.status, newKey: make ? 'fbd_local-key-wxyz' : undefined };
      }
      return unwrap<DeployStatus & { newKey?: string }>(make ? await adminApi.post('/extensions/deploy/key') : await adminApi.delete('/extensions/deploy/key'));
    },
    onSuccess: ({ newKey: _shownOnce, ...status }) => qc.setQueryData(DEPLOY, status),
  });
}

// ── Building from the organisation's own repository ──────────────────────

export interface ExtensionBuildRow {
  id: string;
  trigger: 'MANUAL' | 'COMMIT';
  branch: string;
  commit: string;
  commitMessage: string;
  status: 'BUILDING' | 'DEPLOYING' | 'LIVE' | 'FAILED';
  message: string;
  output: string;
  at: string | null;
}
export interface RepoView {
  available: boolean;
  repo: { url: string; host: string; branch: string; auto: boolean; publicKey: string; hookUrl: string } | null;
  builds: ExtensionBuildRow[];
}
type RepoAsk = { link: string } | { branch?: string; auto?: boolean } | 'unlink' | 'build';

let localRepo: { view: RepoView; branches: string[] | Error; asked: RepoAsk[] } | undefined;
/** Tests: what the API would answer about the repository, and what gets asked of it. */
export const seedLocalRepo = (seed?: { view: RepoView; branches: string[] | Error }) => {
  localRepo = seed && { ...seed, asked: [] };
  return localRepo;
};
const REPO = [...KEY, 'repo'] as const;
export const buildUnderWay = (v?: RepoView) => !!v?.builds.some((b) => b.status === 'BUILDING' || b.status === 'DEPLOYING');

export function useRepo() {
  return useQuery({
    queryKey: REPO,
    queryFn: async () => (USE_API ? unwrap<RepoView>(await adminApi.get('/extensions/repo')) : (localRepo?.view ?? { available: false, repo: null, builds: [] })),
    refetchInterval: (q) => (buildUnderWay(q.state.data) ? 3000 : false),
    retry: false,
  });
}

/** The repository's branches, read with the organisation's key; failing means the key has not been added yet. */
export function useRepoBranches(enabled: boolean) {
  return useQuery({
    queryKey: [...REPO, 'branches'],
    enabled,
    queryFn: async () => {
      if (USE_API) return unwrap<string[]>(await adminApi.get('/extensions/repo/branches'));
      if (localRepo?.branches instanceof Error) throw localRepo.branches;
      return localRepo?.branches ?? [];
    },
    retry: false,
    staleTime: 30_000,
  });
}

/** Every change to the link: linking, the branch, deploying on commits, unlinking, and "Deploy now". */
export function useRepoChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ask: RepoAsk) => {
      if (!USE_API) {
        const l = localRepo!;
        l.asked.push(ask);
        if (ask === 'unlink') l.view = { ...l.view, repo: null };
        else if (ask === 'build') l.view = { ...l.view, builds: [{ id: `b${l.asked.length}`, trigger: 'MANUAL', branch: l.view.repo!.branch, commit: '', commitMessage: '', status: 'BUILDING', message: '', output: '', at: null }, ...l.view.builds] };
        else if ('link' in ask) l.view = { ...l.view, repo: { url: ask.link, host: 'github.com', branch: 'main', auto: false, publicKey: 'ssh-ed25519 AAAAlocal form-builder-deploy', hookUrl: 'https://api.forms.test/extensions/repo/hook/local-token' } };
        else l.view = { ...l.view, repo: { ...l.view.repo!, ...ask } };
        return l.view;
      }
      if (ask === 'unlink') return unwrap<RepoView>(await adminApi.delete('/extensions/repo'));
      if (ask === 'build') return unwrap<RepoView>(await adminApi.post('/extensions/repo/builds'));
      if ('link' in ask) return unwrap<RepoView>(await adminApi.put('/extensions/repo', { url: ask.link }));
      return unwrap<RepoView>(await adminApi.patch('/extensions/repo', ask));
    },
    onSuccess: (view) => {
      qc.setQueryData(REPO, view);
      void qc.invalidateQueries({ queryKey: DEPLOY });
    },
  });
}
