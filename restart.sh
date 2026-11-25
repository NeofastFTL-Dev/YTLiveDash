#!/usr/bin/env bash
# Restart the timer server.
# Under systemd (the normal setup) this hands the job to systemd, because a
# manual kill would just make systemd spawn a second copy next to ours.
set -u
cd "$(dirname "$0")"

UNIT="$HOME/.config/systemd/user/stream-timer.service"
if [ -f "$UNIT" ] && systemctl --user is-active --quiet stream-timer; then
  systemctl --user restart stream-timer
  sleep 1
  echo "restarted stream-timer.service (pid $(systemctl --user show -p MainPID --value stream-timer))"
  echo "  dashboard: http://localhost:8123/"
  echo "  overlay:   http://localhost:8123/overlay.html"
  echo "  logs:      journalctl --user -u stream-timer -f"
  printf "  health:    "
  curl -s --max-time 3 http://127.0.0.1:8123/api/health || echo "no answer — see: journalctl --user -u stream-timer -n 50"
  echo
  exit 0
fi

PIDFILE="server.pid"

if [ -f "$PIDFILE" ]; then
  OLD=$(cat "$PIDFILE" 2>/dev/null || true)
  if [ -n "${OLD:-}" ] && kill -0 "$OLD" 2>/dev/null; then
    kill "$OLD" 2>/dev/null
    for _ in $(seq 1 30); do kill -0 "$OLD" 2>/dev/null || break; sleep 0.1; done
    echo "stopped previous server (pid $OLD)"
  else
    echo "stale $PIDFILE (pid ${OLD:-unknown} not running)"
  fi
  rm -f "$PIDFILE"
else
  echo "no $PIDFILE — starting fresh"
fi

setsid bash -c 'echo $$ > server.pid; exec node server.js' >> server.log 2>&1 < /dev/null &

for _ in $(seq 1 40); do
  [ -s "$PIDFILE" ] && break
  sleep 0.1
done
NEW=$(cat "$PIDFILE" 2>/dev/null || echo "?")
sleep 0.4

echo "started server (pid $NEW)"
echo "  dashboard: http://localhost:8123/"
echo "  overlay:   http://localhost:8123/overlay.html"
if command -v curl >/dev/null 2>&1; then
  printf "  health:    "
  curl -s --max-time 3 http://127.0.0.1:8123/api/health || echo "no answer — see server.log"
  echo
fi
