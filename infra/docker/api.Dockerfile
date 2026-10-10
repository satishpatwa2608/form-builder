# The API and the worker (one image, two commands). Build from the repository root:
#   docker build -f infra/docker/api.Dockerfile -t fb-api:local .
FROM node:20-bookworm-slim AS build
# The test suite's in-memory MongoDB would download a server binary on install; the image has no use for it.
ENV MONGOMS_DISABLE_POSTINSTALL=1 CI=1
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @fb/api...
RUN pnpm --filter @fb/engine --filter @fb/connectors --filter @fb/sdk --filter @fb/api build
# A self-contained copy of the API with production dependencies only.
RUN pnpm --filter @fb/api deploy --prod /out

FROM node:20-bookworm-slim
# git and ssh: to read the branches of the repository a customer links for its extension (extension-repo.service.ts).
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out .
RUN mkdir -p /data/uploads && chown node:node /data/uploads
USER node
EXPOSE 4100
CMD ["node", "dist/main.js"]
