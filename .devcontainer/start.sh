#!/usr/bin/env bash
# Starts (or restarts) the app each time the Codespace starts. The first run
# builds the images and takes several minutes.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose -f docker-compose.yml -f .devcontainer/compose.codespaces.yml up -d --build

echo
echo "Mike is starting. Open port 3000 from the Ports tab (or the pop-up)."
echo "Check progress with: docker compose ps"
echo "Document uploads need port 9000 set to Public: see docs/codespaces.md."
