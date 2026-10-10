# Deploying your own code to Form Builder

A short guide for your administrators and developers. For what the code itself can
do and how to write it, see [extensions.md](extensions.md).

## The idea in one minute

Some things cannot be set up on screen: a rule only your business knows, a
calculation, a decision about who should handle a request. For these you write a
small service of your own, called an **extension**. You deploy it yourself, and
Form Builder runs it for your organisation only.

Once it is running, what it offers appears in the builder:

| Your code declares | Designers find it |
|---|---|
| A workflow step | In a form's workflow: add a step, choose **Custom API** |
| A list | In a dropdown's settings, as where its options come from |
| A check | In a form's settings, under **Checks from your extension** |
| A field | In the builder's palette, under **Your extension** |

There are no webhooks to host and no servers for you to run.

## Two ways to deploy

| | From your repository (the usual way) | Building it yourselves |
|---|---|---|
| You need | The repository's address | Docker on a developer's computer or pipeline |
| A deployment is | **Deploy now**, or every commit to the branch you chose | Build, push, choose the version, **Deploy** |
| Good for | Almost everyone | Teams whose code may not be read from outside |

Both end the same way: the version runs, and if it does not start the one before
keeps running.

## Deploying from your repository

In Form Builder open **Administration → Extensions**, the part called **Deploy
from your repository**.

1. **Link it.** Paste the repository's address, for example
   `https://github.com/your-company/your-extension`, and press **Link the
   repository**. GitHub, GitLab and Bitbucket work.
2. **Let Form Builder read it.** The page shows a key. Add it to the repository
   (in GitHub: *Settings → Deploy keys → Add deploy key*, leaving "Allow write
   access" off). It can read that one repository and change nothing. Press
   **I have added it: check**.
3. **Choose the branch** to deploy. The list is your repository's own branches.
4. **Deploy now** builds that branch as it stands and deploys it. The **Builds**
   list shows each build: what started it, the commit, the result, and what was
   printed if it failed.

### On every commit

Tick **Deploy on every commit to this branch**. The page shows an address; add
it to the repository so it tells Form Builder when the branch changes (in
GitHub: *Settings → Webhooks → Add webhook*, content type `application/json`,
"Just the push event"). From then on a commit to that branch is built and
deployed by itself. Commits to other branches are ignored. If a commit arrives
while a build is under way, it is built when that one finishes.

Keep that address to yourselves: anyone who has it can start a build of your
branch (of your own code, and nothing else). **Unlink** and link again to get a
new one.

### What your repository must contain

The starter kit as we give it: `package.json`, `tsconfig.json`, `src/` and
`vendor/`. Form Builder builds it with its own build file; a `Dockerfile` in
your repository is not used.

The rest of this guide is about building it yourselves.

## Who does what

| Person | Does |
|---|---|
| Developer | Writes the code, builds it as a Docker image, pushes it |
| Administrator of your organisation | Gets the push sign-in, chooses the version, presses Deploy |
| Form designer | Uses the steps, lists and checks in forms |

One person can do all three.

## What you need

- A plan that includes extensions.
- The role of administrator in your organisation in Form Builder.
- The starter kit from us: a small project with the SDK, a `Dockerfile` and an
  example. Keep it in a git repository of your own, and keep that repository private.
- Docker on the developer's computer.

## The first deployment

### 1. Write the code

Everything is in `src/index.ts`. A workflow step looks like this:

```ts
ext.step(
  { key: 'triage-issue', label: 'Triage the plant issue', outputs: ['urgency', 'team'] },
  async ({ values }) => {
    const urgency = String(values.description ?? '').includes('fire') ? 'CRITICAL' : 'NORMAL';
    return { summary: `Urgency ${urgency}`, data: { urgency, team: 'Maintenance' } };
  },
);
```

`key` is how forms remember the step: never rename one that is in use.
`outputs` are the values later steps of the workflow can use.

### 2. Get the push sign-in

In Form Builder open **Administration → Extensions**. Under **Deploy your own
code**, press **Show the push commands**. Three commands appear, each with a Copy
button. The sign-in:

- works for one hour,
- works only for your organisation's own image space,
- is not shown again (press the button again for a new one).

### 3. Build and push

In a terminal, in the folder of your project, run the three commands in order:

```sh
docker login <image space> -u AWS -p <password>
docker build --platform linux/arm64 -t <image space>/fb-ext/<your organisation>:v1 .
docker push <image space>/fb-ext/<your organisation>:v1
```

`v1` is the name of this version. Give every version a new name (`v2`, `v3`, or
a date such as `2026-10-09`). The build must be for the platform the page shows.

### 4. Deploy

Back on the Extensions page:

1. Press **Look again for pushed versions**.
2. Choose the version.
3. Press **Deploy**.

Within about a minute the page shows **Running**, and lists the steps, lists and
checks your code offers. Designers can use them straight away.

## Putting a change live

1. Change the code and commit it.
2. Get a push sign-in if the last one has expired (step 2 above).
3. Build and push under a new version name.
4. Choose the new version and press **Deploy**.

The new version replaces the running one. To go back, choose an earlier version
and press **Deploy** again; the last ten versions you pushed are kept.

## If a deployment fails

The page says why, and under **What your code printed** shows the end of your
code's own output. Nothing is lost: the version that was running keeps running.

| The page says | What to do |
|---|---|
| It was built for another platform | Build again with `--platform linux/arm64` |
| It did not start | Read what your code printed; it usually names the error. Run it on your own computer first |
| It could not be fetched | Push the version again, then deploy |
| What it offers could not be read | A key or label in your code is not valid; see extensions.md |
| A deployment is already under way | Wait for it to finish; one runs at a time |
| Your plan does not include extensions | Ask us about your plan |

Every request is also in your **Audit trail** and in **Logs**, under the area
*Extensions*.

## Removing it

**Remove the extension** on the same page stops it. Its steps, lists and checks
are no longer offered, and forms that use them must be changed before they can be
published again.

## What your code can and cannot do

- It runs for your organisation only. No other customer can reach it or see it.
- It cannot reach Form Builder's database. It receives only what a form or
  workflow sends it.
- It cannot call the internet or your own systems yet. Tell us if you need this.
- It gets 256 MB of memory and half a processor, and cannot write to its own disk
  (except `/tmp`). Keep an image under 1 GB.
- Version names use letters, digits, `.`, `_` and `-`.

## Questions

**We keep our code in GitHub. Does that change anything?**
No. Git is where you keep and review the code. Deploying is always: build, push,
choose the version, Deploy.

**Can our pipeline deploy on every commit?**
Yes. On the Extensions page, under **Or deploy on every commit**, press **Make
a deploy key**. The starter kit already has a GitHub Actions workflow
(`.github/workflows/deploy.yml`). In your repository on GitHub, under
**Settings → Secrets and variables → Actions**, add:

- the secret `FB_DEPLOY_KEY`: the key (it is shown once),
- the variable `FB_API_URL`: the address shown beside it on the page.

From then on, every commit to `main` is built, pushed and deployed, and the run
fails with your code's own output if the version does not start. The key can
push to your image space and deploy your extension, and nothing else. Making a
new key stops the old one at once; **Take the key back** stops the pipeline.

**Do we need to restart anything after a deployment?**
No. Form Builder reads what your code offers as part of each deployment.

**Who can deploy?**
Only administrators of your organisation.
