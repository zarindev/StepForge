#!/usr/bin/env bash
# Starts the StepForge demo apps. CareClinic: http://127.0.0.1:8101
# (ShopDesk and Mailpit join in later build phases.)
set -euo pipefail
cd "$(dirname "$0")/.."
exec npm run start -w @stepforge/demo-clinic
