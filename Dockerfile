# syntax=docker/dockerfile:1
# Only CI/build machines install dependencies. The small Mira server loads
# the resulting image; it never runs npm or builds layers during deployment.
FROM node:22.19.0-bookworm-slim AS dependencies
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM node:22.19.0-bookworm-slim
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=256 \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/cache
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
USER node
# No EXPOSE: host networking is intentionally used only for the existing local
# 3000/8788 dependencies and a loopback-only 8787 management API.
CMD ["node", "--env-file=/run/secrets/agent.env", "src/entry/main.mjs", "--channels", "feishu,wecom"]
