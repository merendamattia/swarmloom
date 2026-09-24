# syntax=docker/dockerfile:1
FROM oven/bun:1.3.14 AS dependencies
USER root
RUN --mount=type=cache,target=/var/cache/apt \
  apt-get update \
  && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl gh git nodejs npm pkg-config \
      netcat-openbsd postgresql python3 python3-dev python3-venv redis-server \
  && ln -s /usr/lib/postgresql/*/bin/* /usr/local/bin/ \
  && rm -rf /var/lib/apt/lists/*
ENV BUN_INSTALL_IGNORE_SCRIPTS=1
WORKDIR /app
COPY package.json bun.lock ./
COPY src/backend/package.json src/backend/package.json
COPY src/frontend/package.json src/frontend/package.json
RUN --mount=type=cache,target=/root/.bun/install/cache \
  for attempt in 1 2 3; do \
    bun install --frozen-lockfile && exit 0; \
    echo "bun install failed on attempt $attempt/3" >&2; \
    sleep 5; \
  done; \
  bun install --frozen-lockfile
# Bun arm64 cannot load msgpackr's optional NAPI extractor. Keep its JS fallback even
# when an earlier BuildKit cache contains a compiled artifact.
RUN find node_modules -type f -path '*/msgpackr-extract/build/Release/*.node' -delete

FROM dependencies AS runtime-tools
ARG CODEX_CLI_VERSION=0.156.1
ARG OPENCODE_CLI_VERSION=1.18.18
USER root
ENV npm_config_cache=/root/.npm
RUN --mount=type=cache,target=/root/.npm \
  timeout 300 npm install --global --no-audit --no-fund --fetch-retries=2 --fetch-timeout=60000 \
      "@openai/codex@${CODEX_CLI_VERSION}" "opencode-ai@${OPENCODE_CLI_VERSION}" \
  && node --version \
  && codex --version \
  && opencode --version
COPY requirements.txt /tmp/swarmloom-requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip \
  python3 -m venv /opt/pre-commit \
  && /opt/pre-commit/bin/pip install --no-cache-dir -r /tmp/swarmloom-requirements.txt \
  && ln -sf /opt/pre-commit/bin/pre-commit /usr/local/bin/pre-commit \
  && ln -sf /opt/pre-commit/bin/pip /usr/local/bin/pip \
  && ln -sf /opt/pre-commit/bin/pip3 /usr/local/bin/pip3 \
  && printf '%s\n' '#!/bin/sh' 'exec /opt/pre-commit/bin/python "$@"' > /usr/local/bin/python \
  && printf '%s\n' '#!/bin/sh' 'exec /opt/pre-commit/bin/python3 "$@"' > /usr/local/bin/python3 \
  && chmod +x /usr/local/bin/python /usr/local/bin/python3 \
  && chown -R bun:bun /opt/pre-commit
ENV PATH="/opt/pre-commit/bin:$PATH"

FROM runtime-tools AS dev
# Local development target: node_modules, toolchain (codex/opencode/pre-commit),
# generated Prisma client — no skills, no production frontend build. Source is
# mounted at runtime by docker-compose.yaml.
ENV BUN_INSTALL_CACHE_DIR=/data/bun-cache \
    PIP_CACHE_DIR=/data/pip-cache \
    PRE_COMMIT_HOME=/data/pre-commit-cache
USER root
COPY src/backend/prisma src/backend/prisma
COPY src/backend/prisma.config.ts src/backend/prisma.config.ts
RUN bun run db:generate
COPY AGENTS.md .pre-commit-config.yaml git-conventional-commits.yaml requirements.txt ./
COPY scripts scripts
RUN mkdir -p /data/bun-cache /data/pip-cache /data/pre-commit-cache /data/codex-home /data/opencode-data /data/opencode-config \
  && ln -s /app/scripts/verify-before-commit.sh /usr/local/bin/verify-before-commit \
  && ln -s /app/scripts/swarm-test-services.sh /usr/local/bin/swarm-test-services \
  && chown -R bun:bun /data /app/node_modules/.bun/@prisma+client*
USER bun
WORKDIR /app
EXPOSE 18420 18421
CMD ["bun", "run", "dev"]

FROM runtime-tools AS agent-skills
USER bun
ENV npm_config_cache=/tmp/npx-cache
# bun.sh/docs is documentation, not an installable SKILL.md endpoint. Keep the
# official documentation reference as a build-only global skill instead.
RUN --mount=type=cache,target=/tmp/npx-cache,uid=1000,gid=1000 \
  npx --yes skills@latest add https://github.com/vercel-labs/skills --skill find-skills \
      --global --agent codex opencode claude-code --copy --yes \
  && npx --yes skills@latest add https://github.com/anthropics/skills --skill frontend-design \
      --global --agent codex opencode claude-code --copy --yes \
  && npx --yes skills@latest add https://github.com/vercel-labs/agent-skills \
      --skill vercel-react-best-practices --global --agent codex opencode claude-code --copy --yes \
  && npx --yes skills@latest add https://github.com/vercel-labs/agent-skills \
      --skill web-design-guidelines --global --agent codex opencode claude-code --copy --yes \
  && mkdir -p /tmp/bun-docs-skill \
  && printf '%s\n' \
      '---' \
      'name: bun' \
      'description: Use the official Bun documentation when working with the Bun runtime, package manager, test runner, bundler, or server APIs.' \
      '---' \
      '' \
      '# Bun' \
      '' \
      'Use https://bun.sh/docs as the authoritative reference for current Bun behavior and commands.' \
      > /tmp/bun-docs-skill/SKILL.md \
  && npx --yes skills@latest add /tmp/bun-docs-skill \
      --global --agent codex opencode claude-code --copy --yes \
  && rm -rf /tmp/bun-docs-skill \
  && npx --yes skills@latest add https://github.com/better-auth/skills \
      --skill better-auth-best-practices --global --agent codex opencode claude-code --copy --yes \
  && npx --yes skills@latest add https://github.com/honojs/skills --skill hono \
      --global --agent codex opencode claude-code --copy --yes \
  && npx --yes skills@latest add pbakaus/impeccable \
      --global --agent codex opencode claude-code --copy --yes \
  && npx --yes skills@latest add https://github.com/shadcn/ui --skill shadcn \
      --global --agent codex opencode claude-code --copy --yes \
  && npx --yes skills@latest add https://github.com/tanstack-skills/tanstack-skills \
      --skill tanstack-query --global --agent codex opencode claude-code --copy --yes \
  && npx --yes skills@latest add muthuishere/hand-drawn-diagrams \
      --global --agent codex opencode claude-code --copy --yes \
  && npx --yes skills@latest add ramziddin/solid-skills \
      --global --agent codex opencode claude-code --copy --yes \
  && npx --yes skills@latest add tt-a1i/archify --skill archify \
      --global --agent codex opencode claude-code --copy --yes

FROM agent-skills AS build
USER root
ARG NEXT_PUBLIC_API_URL=http://localhost:18421
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY src/backend src/backend
COPY src/frontend src/frontend
COPY agent-runtime agent-runtime
COPY CHANGELOG.md ./
RUN bun run db:generate && bun run build

FROM build AS runtime
ENV BUN_INSTALL_CACHE_DIR=/data/bun-cache \
    PIP_CACHE_DIR=/data/pip-cache \
    PRE_COMMIT_HOME=/data/pre-commit-cache
COPY AGENTS.md .pre-commit-config.yaml git-conventional-commits.yaml requirements.txt ./
COPY scripts scripts
RUN mkdir -p /data/bun-cache /data/pip-cache /data/pre-commit-cache /data/codex-home /data/opencode-data /data/opencode-config \
  && ln -s /app/scripts/verify-before-commit.sh /usr/local/bin/verify-before-commit \
  && ln -s /app/scripts/swarm-test-services.sh /usr/local/bin/swarm-test-services \
  && chown -R bun:bun /data /app/node_modules/.bun/@prisma+client*
USER bun
WORKDIR /app
EXPOSE 18420 18421
CMD ["bun", "run", "--filter", "swarmloom-backend", "start"]
