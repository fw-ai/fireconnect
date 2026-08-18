#!/usr/bin/env bash
set -euo pipefail
export FIREWORKS_API_KEY="${FIREWORKS_API_KEY:?FIREWORKS_API_KEY required}"
exec expect -f "$(dirname "$0")/record-model-selection-demo.exp"
