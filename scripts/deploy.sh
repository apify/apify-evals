#!/usr/bin/env bash
# Deploy one monorepo actor via `apify push`.
#
# The platform rejects dockerContextDir pointing outside the uploaded source,
# so we upload the repo root as the actor source: this script materializes a
# root-level .actor/actor.json for the chosen actor with paths rewritten
# relative to the repo root, pushes, and cleans up.
#
# Usage: scripts/deploy.sh workflow-runner|judge
set -euo pipefail
cd "$(dirname "$0")/.."

ACTOR_DIR="actors/$1"
[ -f "$ACTOR_DIR/.actor/actor.json" ] || { echo "unknown actor: $1" >&2; exit 1; }

trap 'rm -rf .actor' EXIT
rm -rf .actor && mkdir .actor

# Paths in actor.json resolve relative to the actor.json file (root/.actor/).
# The input schema is inlined because nested .actor/ dirs are not uploaded.
jq --arg dir "$ACTOR_DIR" --slurpfile schema "$ACTOR_DIR/.actor/input_schema.json" '
    .dockerfile = "../\($dir)/Dockerfile"
    | .dockerContextDir = ".."
    | .input = $schema[0]
' "$ACTOR_DIR/.actor/actor.json" > .actor/actor.json

apify push --dir .
