#!/bin/bash
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/lib/node_modules/corepack/shims:$PATH"
export COMBYNE_MIGRATION_PROMPT="never"
cd "$(dirname "$0")/.." || exit 1
exec pnpm dev
