FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
RUN corepack enable \
  && npm install --global @openai/codex@0.147.0 \
  && mkdir -p /data \
  && chown -R node:node /app /data
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app /app
RUN chmod 755 /app/local/docker-entrypoint.sh
EXPOSE 3000 3210
ENTRYPOINT ["/app/local/docker-entrypoint.sh"]
CMD ["node", "--experimental-strip-types", "local/run.ts", "start"]
