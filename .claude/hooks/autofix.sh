#!/usr/bin/env bash
set -euo pipefail

FILE=$(jq -r '.tool_input.file_path')

case "$FILE" in
  *.py)
    uv run ruff check --fix "$FILE"
    uv run ruff format "$FILE"
    ;;
  *.js|*.mjs|*.cjs|*.jsx|*.ts|*.mts|*.cts|*.tsx|*.css|*.json|*.jsonc)
    npx biome check --write "$FILE"
    ;;
esac
