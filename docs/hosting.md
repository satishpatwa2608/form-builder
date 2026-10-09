# Hosting customers, and their own code, on Docker

_For whoever runs the platform._

A customer who buys Form Builder and wants their own code in it can be hosted
in two ways. Both use the same images, the same commands and the same
extension contract ([extensions.md](extensions.md)); a customer can move from
one to the other without changing their code.

| | Shared | Dedicated |
|---|---|---|
| The product | One installation for every customer | An installation for this customer alone |
| Database, keys, addresses | Shared (each organisation's data is separated by the product) | Their own |
| Their code | A container of its own beside the installation | A container of its own beside *their* installation |
| Cost to run | One small container per customer | A whole stack per customer |
| Suits | Most customers | Customers who must be isolated, or want their own release timing |

Nobody is given the product's source in either case. A customer's repository
holds only their extension.

## What runs

One installation is five containers (`infra/docker/compose.yml`):

- **mongo**: the database. On a network only the API and the worker are on;
  published nowhere.
- **api**: the API. **worker**: the same image, running queued jobs.
- **studio** and **runtime**: the builder and the public form app, as static
  files behind nginx. Their addresses are fixed into them when they are built.

A customer's extension is one more container, on a private network that only
it, the API and the worker are on. It is started locked down: not root,
read-only disk, no extra rights, 256 MB of memory, half a CPU, no published
port, no route to the database, to another customer's container or to the
internet.

## Commands

Everything goes through one tool:

```
pnpm stack build                                          # the API image
pnpm stack up <project> [--api-port 4100] [--studio-port 5173] [--runtime-port 5174] [--plan ENTERPRISE]
pnpm stack down <project> [--volumes]                     # --volumes also deletes its data and keys
pnpm stack op <project> set-plan <orgId> <PLAN>           # operator commands, inside the API container
pnpm stack op <project> extension list <orgId>

pnpm stack ext init <directory>                           # a new extension repository, from the starter
pnpm stack ext deploy <project> <orgId> <repository>      # the delivery pipeline
pnpm stack ext remove <project> <orgId>
```

`<project>` names an installation. Its generated keys and each extension's
secret are kept in `infra/.state/<project>/`, readable by the owner only and
never committed. **Keep that folder**: without the keys an installation cannot
read its own connector credentials.

## Shared hosting

```
pnpm stack up fb                                   # once
# for each customer who wants their own code:
pnpm stack ext init ../acme-extension              # (or they bring their repository)
pnpm stack ext deploy fb <acme's orgId> ../acme-extension
```

The organisation id is shown in the builder under Organisation. The customer's
plan must include extensions (`extensions` in `apps/api/src/plans/plans.ts`:
none on Free and Team, one on Business, unlimited on Enterprise; placeholder
numbers).

## Dedicated hosting

```
pnpm stack up fb-acme --api-port 4200 --studio-port 5200 --runtime-port 5201
# the customer signs up in their own installation, then:
pnpm stack ext deploy fb-acme <their orgId> ../acme-extension
```

A dedicated installation has its own database volume, its own keys and its
own web addresses. Nothing is shared with any other installation.

## What `ext deploy` does (the delivery pipeline)

1. **Builds** the customer's repository into an image, always with
   `infra/docker/extension.Dockerfile`. A Dockerfile in their repository is
   ignored: what runs at build time and how the image starts is ours to
   decide.
2. **First time only:** creates the private network, puts the API and worker
   on it, installs the extension for the organisation and keeps the secret it
   issues.
3. **Replaces** the running container with the new image and waits for it to
   answer. If it does not, **the previous version is started again** and the
   command fails with the container's last output.
4. **Has the API read** what the new version offers, so it appears in the
   builder without anyone choosing "Read again".

A version that does not build never reaches step 3.

On this single-host setup, the first delivery for a customer attaches the API
to a new network, which closes connections that clients were keeping open;
new connections work at once. An orchestrator attaches networks when a
container is created, so this does not arise there.

After `stack up` is run again (an upgrade, a restart), the new API and worker
containers are put back on every extension's network.

## Testing

```
pnpm e2e:docker
```

Needs Docker running. It builds the images, brings up a shared installation
with two customers and a dedicated one, delivers their extensions, and checks
in a real browser and from inside the containers that it all behaves as
described here, including a bad version, a stopped container, a restart, a
plan without extensions, and removal. It cleans up after itself
(`E2E_KEEP=1` leaves everything running to look at). First run: several
minutes.

## What is still to do for production

This is the working model on one Docker host. A production deployment needs:

- **An orchestrator** (ECS, Kubernetes) in place of this tool, with the same
  rules: private network per extension, no route to the database, locked-down
  containers. The hosting decisions in status.md come first.
- **A registry** for the SDK and for customers' images. Today the SDK is
  copied into the customer's repository (`vendor/`) at build time.
- **A build service** for customers' repositories: `npm install` runs their
  dependencies' install scripts, so builds belong on disposable machines.
- **A secrets manager** in place of `infra/.state/`.
- **Agreed outbound access** per customer, for extensions that must call the
  customer's own systems. Here an extension has no outbound access at all.
- **HTTPS, real mail and file storage.** Local Docker runs with
  `NODE_ENV=development`; production mode requires SES, S3, KMS and secure
  cookies.
