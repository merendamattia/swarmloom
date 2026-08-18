# syntax=docker/dockerfile:1
FROM oven/bun:1.3.14 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
COPY src/backend/package.json src/backend/package.json
COPY src/frontend/package.json src/frontend/package.json
COPY AGENTS.md .pre-commit-config.yaml git-conventional-commits.yaml requirements.txt ./
COPY scripts scripts
RUN --mount=type=cache,target=/root/.bun/install/cache \
  for attempt in 1 2 3; do \
    bun install --frozen-lockfile && exit 0; \
    echo "bun install failed on attempt $attempt/3" >&2; \
    sleep 5; \
  done; \
  bun install --frozen-lockfile

FROM dependencies AS runtime-tools
ARG CODEX_CLI_VERSION=0.147.0
ARG OPENCODE_CLI_VERSION=1.18.18
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gh git nodejs npm python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/pre-commit \
  && /opt/pre-commit/bin/pip install --no-cache-dir -r requirements.txt
RUN timeout 300 npm install --global --no-audit --no-fund --fetch-retries=2 --fetch-timeout=60000 \
      "@openai/codex@${CODEX_CLI_VERSION}" "opencode-ai@${OPENCODE_CLI_VERSION}" \
  && node --version \
  && codex --version \
  && opencode --version
ENV PATH="/opt/pre-commit/bin:$PATH"

FROM runtime-tools AS agent-skills
USER bun
# bun.sh/docs is documentation, not an installable SKILL.md endpoint. Keep the
# official documentation reference as a build-only global skill instead.
RUN npx --yes skills@latest add https://github.com/vercel-labs/skills --skill find-skills \
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
  && npx --yes skills@latest add https://github.com/yusukebe/hono-skill --skill hono \
      --global --agent codex opencode claude-code --copy --yes \
  && npx --yes skills@latest add pbakaus/impeccable \
      --global --agent codex opencode claude-code --copy --yes \
  && npx --yes skills@latest add https://github.com/shadcn/ui --skill shadcn \
      --global --agent codex opencode claude-code --copy --yes \
  && npx --yes skills@latest add https://github.com/tanstack-skills/tanstack-skills \
      --skill tanstack-query --global --agent codex opencode claude-code --copy --yes \
  && npx --yes skills@latest add ramziddin/solid-skills \
      --global --agent codex opencode claude-code --copy --yes

FROM agent-skills AS build
USER root
ARG NEXT_PUBLIC_API_URL=http://localhost:18421
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY src/backend src/backend
COPY src/frontend src/frontend
COPY agent-runtime agent-runtime
RUN bun run db:generate && bun run build

FROM build AS runtime
RUN mkdir -p /data/codex-home /data/opencode-data /data/opencode-config \
  && ln -s /app/scripts/verify-before-commit.sh /usr/local/bin/verify-before-commit \
  && chown -R bun:bun /data /app
USER bun
WORKDIR /app
EXPOSE 18420 18421
CMD ["bun", "run", "--filter", "swarmloom-backend", "start"]
