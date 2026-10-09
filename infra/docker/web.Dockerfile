# The builder (studio) or the public form app (runtime), as static files behind nginx.
#   docker build -f infra/docker/web.Dockerfile --build-arg APP=studio --build-arg VITE_API_URL=... -t fb-studio:local .
# The addresses are fixed into the files when they are built, so an installation with other addresses is built again.
FROM node:20-bookworm-slim AS build
ARG APP
ARG VITE_API_URL
ARG VITE_STUDIO_URL
ARG VITE_RUNTIME_URL
ENV CI=1 VITE_API_URL=$VITE_API_URL VITE_STUDIO_URL=$VITE_STUDIO_URL VITE_RUNTIME_URL=$VITE_RUNTIME_URL
RUN corepack enable
WORKDIR /repo
COPY . .
# The public form app is built from the builder's form code, so both sets of dependencies are needed for either.
RUN pnpm install --frozen-lockfile --filter @fb/studio... --filter @fb/runtime...
RUN pnpm --filter @fb/engine build && pnpm --filter @fb/${APP} build

FROM nginx:1.27-alpine
ARG APP
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/${APP}/dist /usr/share/nginx/html
EXPOSE 80
