#!/usr/bin/env bash
# Starts the StepForge demo apps on their own (StepForge's "Load demo workspace" starts them for you):
#   CareClinic http://127.0.0.1:8101 · ShopDesk http://127.0.0.1:8102 · Mailpit http://127.0.0.1:8025 (SMTP 1025)
set -euo pipefail
cd "$(dirname "$0")/.."
pids=()
trap 'kill "${pids[@]}" 2>/dev/null' EXIT INT TERM
if [ -x data/bin/mailpit ]; then
  data/bin/mailpit --listen 127.0.0.1:8025 --smtp 127.0.0.1:1025 >/dev/null 2>&1 & pids+=($!)
else
  echo "Mailpit is not installed (npm run mailpit:install); CareClinic's sign-up emails will fail."
fi
npm run start -w @stepforge/demo-clinic & pids+=($!)
npm run start -w @stepforge/demo-shop & pids+=($!)
wait
