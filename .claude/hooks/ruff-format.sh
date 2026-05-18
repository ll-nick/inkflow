#!/usr/bin/env bash
set -euo pipefail

FILE=$(jq -r '.tool_input.file_path' )

[[ "$FILE" == *.py ]] || exit 0

uv run ruff format "$FILE"
