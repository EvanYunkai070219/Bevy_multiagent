#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"

exec "$repo_dir/node_modules/.bin/tsx" \
  "$repo_dir/apps/server/scripts/self-healing-demo.ts"
