#!/usr/bin/env sh
set -eu

pre-commit run --all-files
bun run verify
