#!/usr/bin/env bash
# Install the dashboard APK on the phone once it appears over adb.
#   ./install-adb.sh
set -euo pipefail

ADB="${ANDROID_HOME:-$HOME/Android/Sdk}/platform-tools/adb"
APK="$(cd "$(dirname "$0")/.." && pwd)/emilli-remote.apk"

[ -x "$ADB" ] || { echo "adb not found at $ADB"; exit 1; }
[ -f "$APK" ] || { echo "missing $APK — run ./build-apk.sh first"; exit 1; }

"$ADB" start-server >/dev/null 2>&1 || true
STATE="$(timeout 15 "$ADB" get-state 2>/dev/null || true)"
if [ "$STATE" != "device" ]; then
  echo "no phone yet — plug it in, unlock it, and accept 'Allow USB debugging'."
  "$ADB" devices
  exit 1
fi

MODEL="$(timeout 10 "$ADB" shell getprop ro.product.model 2>/dev/null | tr -d '\r' || echo phone)"
echo "installing $(basename "$APK") on ${MODEL}…"
"$ADB" install -r "$APK"
"$ADB" shell am start -n ftl.emilli.remote/.MainActivity >/dev/null 2>&1 || true
echo "done. if it asks for a PIN: run ./remote-url.sh on this PC."
echo "crash check: $ADB logcat -d -s AndroidRuntime | tail -30"
