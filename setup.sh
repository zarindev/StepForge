#!/usr/bin/env bash
# StepForge setup for macOS / Linux. Installs dependencies, the Playwright Chromium browser and builds the dashboard.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required. Install it from https://nodejs.org and run this script again." >&2
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20+ is required (found $(node -v))." >&2
  exit 1
fi
echo "    Node $(node -v)"

echo "==> Installing dependencies"
npm install

echo "==> Installing Playwright Chromium"
npx playwright install chromium

echo "==> Installing Mailpit (local email catcher)"
npm run mailpit:install || echo "    Mailpit could not be installed now; retry from Settings → Email."

echo "==> Building the dashboard"
npm run build

mkdir -p data
echo
echo "StepForge is ready. Start it with:  ./start.sh"
