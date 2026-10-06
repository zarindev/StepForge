#!/bin/sh
# StepForge CLI for macOS/Linux (by Md Zarin Tasnim). Usage: ./stepforge.sh run --app <slug> --env <name>
exec node "$(dirname "$0")/apps/cli/bin/stepforge.mjs" "$@"
