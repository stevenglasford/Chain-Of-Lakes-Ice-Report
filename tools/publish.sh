#!/usr/bin/env bash
# publish.sh - export the sheet and push data/ if it changed.
#
#   tools/publish.sh            run from a clone kept ONLY for this job
#
# Meant for cron on the home server. It resets its clone to origin/main before
# it starts, so it must never be pointed at a working copy somebody edits by
# hand: use a separate clone (FREEZE_CLONE, default ~/appdata/freeze-publisher/repo).
# It only ever adds a commit that touches data/, and it never force-pushes.
set -euo pipefail

CLONE="${FREEZE_CLONE:-$HOME/appdata/freeze-publisher/repo}"
REMOTE="${FREEZE_REMOTE:-git@github.com:stevenglasford/Chain-Of-Lakes-Ice-Report.git}"
LOCK="${CLONE%/repo}/publish.lock"

mkdir -p "$(dirname "$CLONE")"
exec 9>"$LOCK"
flock -n 9 || exit 0

if [ ! -d "$CLONE/.git" ]; then
  git clone -q "$REMOTE" "$CLONE"
fi
cd "$CLONE"
case "$(git rev-parse --show-toplevel)" in
  */freeze-publisher/repo) ;;
  *) echo "refusing to run outside a freeze-publisher clone: $(pwd)" >&2; exit 1 ;;
esac

git fetch -q origin main
git checkout -q -B main origin/main
git reset -q --hard origin/main

python3 tools/build_data.py

git add data
if git diff --cached --quiet; then
  exit 0
fi
N=$(python3 -c "import json;print(json.load(open('data/manifest.json'))['observations'])")
LAST=$(python3 -c "import json;print(json.load(open('data/manifest.json'))['last_date'])")
git -c user.name="Minneapolis Frozen Lakes Report (data export)" \
    -c user.email="stevenglasford@users.noreply.github.com" \
    commit -q -m "data: $N observations through $LAST"
git push -q origin main
echo "$(date -Is) published: $N observations through $LAST"
