#!/usr/bin/env sh
# SPDX-License-Identifier: MIT
set -e
NODE="$(command -v node)"
SCRIPT="$(cd "$(dirname "$0")" && pwd)/skills/c2/scripts/build-index.mjs"
# cron discards (or mails) job output, which would hide a crawl that reports failures and exits
# non-zero, so the scheduled run keeps its own log next to the catalog.
DATA_DIR="${CODEX_HOME:-$HOME/.codex}/c2"
LOG="$DATA_DIR/cron.log"
mkdir -p "$DATA_DIR"
(crontab -l 2>/dev/null | grep -v 'c2-catalog-update' ; echo "0 9 * * 1 $NODE $SCRIPT >> $LOG 2>&1 # c2-catalog-update") | crontab -
echo "Registered c2-catalog-update (Monday 09:00); output goes to $LOG."
