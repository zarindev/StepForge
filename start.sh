#!/usr/bin/env bash
# Starts StepForge at http://127.0.0.1:4400 (or the next free port) and opens the dashboard.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "Dependencies are missing. Run ./setup.sh first." >&2
  exit 1
fi
if [ ! -f apps/web/dist/index.html ]; then
  echo "==> Building the dashboard (first start)"
  npm run build
fi
exec npm start
