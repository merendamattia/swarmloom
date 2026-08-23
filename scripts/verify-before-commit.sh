#!/usr/bin/env sh
set -eu

pre-commit run --all-files
bun run db:generate
bun run db:deploy
bun run verify
