#!/usr/bin/env bash
# Print the tunnel's current public URL (the one Ko-fi has to point at).
# Quick-tunnel hostnames are new on every cloudflared start, so always check
# this after a reboot, a crash or a tunnel restart.
#
# Under systemd the journal is the only trustworthy source: tunnel.log belongs
# to the old hand-started process and its hostname is dead the moment that
# process exits. The printed URL is verified, so a stale one cannot pass.
set -u
cd "$(dirname "$0")"

UNIT="$HOME/.config/systemd/user/stream-timer-tunnel.service"
URL=""

if [ -f "$UNIT" ]; then
  URL=$(journalctl --user -u stream-timer-tunnel -o cat --no-pager 2>/dev/null \
    | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1)
else
  URL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' tunnel.log 2>/dev/null | tail -1)
fi

if [ -z "$URL" ]; then
  echo "no tunnel URL yet — the tunnel is still starting (journalctl --user -u stream-timer-tunnel -n 30)" >&2
  exit 1
fi

# Verify it is the live tunnel: a dead quick-tunnel hostname answers 530 and a
# brand-new one can take a few seconds to be routed. Only /kofi is published,
# so / answering 403 is the healthy case.
CODE=""
for _ in $(seq 1 6); do
  CODE=$(curl -s -o /dev/null --max-time 5 -w "%{http_code}" "$URL/" 2>/dev/null || true)
  case "$CODE" in
    # 200/403 = dashboard/tunnel healthy; 401 = the remote login page, which is
    # the expected answer now that the tunnel is token-protected.
    200|401|403) break ;;
    *) CODE="" ; sleep 3 ;;
  esac
done

echo "$URL/kofi"
if [ -z "$CODE" ]; then
  echo "warning: that hostname is not answering yet — if this keeps up, check journalctl --user -u stream-timer-tunnel -n 30" >&2
  exit 2
fi
echo "live (HTTP $CODE on / — only /kofi is published)" >&2
