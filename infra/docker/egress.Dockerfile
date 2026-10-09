# The way out for one customer's extension: a proxy that lets through only agreed addresses.
#   docker build -f infra/docker/egress.Dockerfile -t fb-egress:local infra/egress
FROM node:24-alpine
WORKDIR /app
COPY proxy.mjs ./
USER node
EXPOSE 3128
CMD ["node", "proxy.mjs"]
