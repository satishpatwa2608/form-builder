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
pnpm stack ext allow <project> <orgId> [host[:port][=private] ...]   # what it may call out to
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

## Letting an extension call the customer's own systems

An extension starts with no way out. When a customer needs their code to call
their own systems (an ERP, a credit bureau), agree the addresses with them and
set the list:

```
pnpm stack ext allow fb <orgId> api.acme.com erp.acme.com:8443
pnpm stack ext allow fb <orgId>                 # nothing: closes it again
```

- An entry is a host name and a port (443 when left out). No wildcards, no
  bare addresses.
- The extension gets a **proxy of its own**, and its container is restarted to
  use it. The customer's code changes nothing: an ordinary `fetch` (or
  `http`/`https` request) goes through it.
- Only listed addresses get through. Anything else fails for their code, and
  the reason is in the proxy's record: `docker logs <extension>-egress` has one
  line for every attempt, allowed or refused.
- A name that resolves to a **private address is refused**, so a customer
  cannot point a listed name at something inside our network. For a system
  reached over a private link, mark the entry: `erp.internal:8080=private`.
- Never reachable, whatever the list says: the machine itself, the cloud's
  metadata address, and the network the proxy shares with the API and worker.
- The extension still has no route of its own. The proxy is the only way out.

## Testing

```
pnpm e2e:docker
```

Needs Docker running. It builds the images, brings up a shared installation
with two customers and a dedicated one, delivers their extensions, and checks
in a real browser and from inside the containers that it all behaves as
described here, including a bad version, a stopped container, a restart, a
plan without extensions, agreed outbound calls, and removal. It cleans up after itself
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
- **One fixed outbound address** for the proxies, so customers can allow-list
  us on their side (the NAT gateway in infra/README.md).
- **HTTPS, real mail and file storage.** Local Docker runs with
  `NODE_ENV=development`; production mode requires SES, S3, KMS and secure
  cookies.
