#!/usr/bin/env sh
set -e
NODE="$(command -v node)"
SCRIPT="$(cd "$(dirname "$0")" && pwd)/skills/c2/scripts/build-index.mjs"
(crontab -l 2>/dev/null | grep -v 'c2-catalog-update' ; echo "0 9 * * 1 $NODE $SCRIPT # c2-catalog-update") | crontab -
echo "Registered c2-catalog-update (Monday 09:00)."
