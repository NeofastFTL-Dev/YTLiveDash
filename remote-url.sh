#!/usr/bin/env bash
# Print the phone URL for use outside the house (mobile data).
# It carries the remote token, so treat it like a password: the first visit
# stores a cookie and then the plain addresses keep working.
set -u
cd "$(dirname "$0")"

TOKEN=$(node -e 'const c=require("./config.json");process.stdout.write(String((c.remote&&c.remote.token)||""))' 2>/dev/null)
if [ -z "$TOKEN" ]; then
  echo "no remote token: set remote.token in config.json and restart the server" >&2
  exit 1
fi

BASE=$(./tunnel-url.sh 2>/dev/null | head -1)
BASE=${BASE%/kofi}
if [ -z "$BASE" ]; then
  echo "no tunnel URL yet — ./tunnel-url.sh for details" >&2
  exit 1
fi

PIN=$(node -e 'const c=require("./config.json");process.stdout.write(String((c.remote&&c.remote.pin)||""))' 2>/dev/null)

echo "$BASE/mobile.html?t=$TOKEN"
echo "login page: $BASE/remote"
if [ -n "$PIN" ]; then echo "PIN for the login form: $PIN"; fi
