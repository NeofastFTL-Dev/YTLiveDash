#!/usr/bin/env bash
# Restart the public tunnel for the Ko-fi webhook and print its URL.
# Under systemd (the normal setup) this hands the job to systemd, so a manual
# start can never leave a second cloudflared and a second live URL behind.
# Quick-tunnel URLs are new on every start — re-paste the printed /kofi URL
# into Ko-fi after running this.
set -u
cd "$(dirname "$0")"

UNIT="$HOME/.config/systemd/user/stream-timer-tunnel.service"
if [ -f "$UNIT" ] && systemctl --user is-active --quiet stream-timer-tunnel; then
  systemctl --user restart stream-timer-tunnel
  echo "restarted stream-timer-tunnel.service"
else
  LOG="tunnel.log"
  PIDFILE="tunnel.pid"

  if [ -f "$PIDFILE" ]; then
    OLD=$(cat "$PIDFILE" 2>/dev/null || true)
    if [ -n "${OLD:-}" ] && kill -0 "$OLD" 2>/dev/null; then
      kill "$OLD" 2>/dev/null
      sleep 1
    fi
    rm -f "$PIDFILE"
  fi

  # No pid file (first run, or it was deleted): stop any orphan tunnel that was
  # started from this directory, so we never leave two live URLs behind.
  # Identified by the process's real executable (/proc/PID/exe) plus its working
  # directory — never by command-line text, which a shell, editor or grep can
  # contain without being cloudflared.
  if [ ! -f "$PIDFILE" ]; then
    for d in /proc/[0-9]*; do
      pid=${d#/proc/}
      [ "$pid" = "$$" ] && continue
      exe=$(readlink "$d/exe" 2>/dev/null) || continue
      case "$exe" in */cloudflared) ;; *) continue ;; esac
      cwd=$(readlink "$d/cwd" 2>/dev/null) || continue
      [ "$cwd" = "$PWD" ] || continue
      if kill "$pid" 2>/dev/null; then echo "stopped orphan cloudflared (pid $pid)"; fi
    done
    sleep 1
  fi

  if [ ! -x ./cloudflared ]; then
    echo "cloudflared not found. Download it once with:"
    echo '  curl -L -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64'
    echo '  chmod +x cloudflared'
    exit 1
  fi

  : > "$LOG"
  setsid bash -c 'echo $$ > tunnel.pid; exec ./cloudflared tunnel --url http://localhost:8123 --no-autoupdate' >> "$LOG" 2>&1 < /dev/null &
  sleep 2
fi

URL=""
for _ in $(seq 1 60); do
  URL=$(./tunnel-url.sh 2>/dev/null | head -1)
  URL=${URL%/kofi}
  [ -n "$URL" ] && break
  sleep 0.5
done

if [ -n "$URL" ]; then
  echo "paste this into Ko-fi → Settings → API → Webhooks → Webhook URL:"
  echo "  $URL/kofi"

  # A brand-new quick-tunnel hostname can take a minute to resolve. Check with
  # a bounded wait so the URL above is not mistaken for a broken one.
  HOST=${URL#https://}
  CODE=""
  printf "checking reachability"
  for _ in $(seq 1 20); do
    CODE=$(curl -s -o /dev/null --max-time 5 -w "%{http_code}" "https://$HOST/" 2>/dev/null || true)
    if [ -n "${CODE:-}" ] && [ "$CODE" != "000" ]; then break; fi
    CODE=""
    printf "."
    sleep 3
  done
  echo
  if [ -n "$CODE" ]; then
    echo "reachable (HTTP $CODE — 403 is the expected answer: only /kofi is published)"
  else
    echo "not answering yet — new hostnames can take a minute; try again shortly"
  fi
else
  echo "no URL yet — check: journalctl --user -u stream-timer-tunnel -n 30"
  tail -n 15 "$LOG" 2>/dev/null
  exit 1
fi
