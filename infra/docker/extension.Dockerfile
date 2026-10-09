# How a customer's extension is built. The pipeline always uses THIS file, never one from
# the customer's repository: what runs at build time and how the image starts is ours to decide.
#   docker build -f infra/docker/extension.Dockerfile -t <tag> <customer repository>
# Node 24: its fetch and http clients go through the outbound proxy when one is given (NODE_USE_ENV_PROXY).
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
# The SDK, put here by the pipeline until it is published to a registry.
COPY vendor ./vendor
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Never as root: the code inside is the customer's.
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
