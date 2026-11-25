#!/usr/bin/env bash
# Build the Emilli Remote APK without Gradle, straight from the SDK tools:
#   aapt2 (resources) → javac → d8 (dex) → zipalign → apksigner
# Output: ../emilli-remote.apk (also served by the timer at /emilli-remote.apk)
#
# The current remote URL (token included) is baked in as the default address, so
# rebuild after the tunnel hostname changes: ./build-apk.sh
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
BT="$SDK/build-tools/35.0.0"
AJAR="$SDK/platforms/android-35/android.jar"
OUT="build"
KS="${KS:-emilli-release.keystore}"   # keep this: updates must be signed with it
# The password never enters git: android/.ks-pass locally, KS_PASS in the
# Actions workflow. Losing it means losing the ability to update over an
# installed copy, so keep a backup next to the keystore.
KS_PASS="${KS_PASS:-$(cat .ks-pass 2>/dev/null || true)}"
[ -n "$KS_PASS" ] || { echo "no signing password: write it to android/.ks-pass or set KS_PASS"; exit 1; }
APK="../emilli-remote.apk"

[ -x "$BT/aapt2" ] || { echo "missing $BT/aapt2 (Android build-tools)"; exit 1; }
[ -f "$AJAR" ] || { echo "missing $AJAR (Android platform 35)"; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" res/values res/drawable
cp ../icons/icon-512.png res/drawable/app_icon.png

# The normal build bakes in the tunnel URL *with the access token*, which is what
# makes a fresh install work out of the box — but it also means that APK must
# never leave this machine. EMILLI_DEFAULT_URL overrides it, so a copy meant for
# a download link can ship with just the LAN address and no token.
DEFAULT_URL="${EMILLI_DEFAULT_URL:-$(../remote-url.sh 2>/dev/null | head -1 || true)}"
if [ -z "$DEFAULT_URL" ]; then
  DEFAULT_URL="http://192.168.100.73:8123/mobile.html"
  echo "note: no tunnel URL available, defaulting to the LAN address"
fi
ESCAPED=$(printf '%s' "$DEFAULT_URL" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')
cat > res/values/defaults.xml <<EOF
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="default_url">$ESCAPED</string>
</resources>
EOF
echo "default address baked in: ${DEFAULT_URL%%\?t=*}?t=<token>"

echo "[1/5] resources"
"$BT/aapt2" compile --dir res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$AJAR" \
  --manifest AndroidManifest.xml -R "$OUT/res.zip" --java "$OUT/gen" --auto-add-overlay

echo "[2/5] java"
javac -source 11 -target 11 -encoding UTF-8 -nowarn -classpath "$AJAR" -d "$OUT/classes" \
  $(find java "$OUT/gen" -name '*.java')

echo "[3/5] dex"
"$BT/d8" --lib "$AJAR" --min-api 24 --output "$OUT" $(find "$OUT/classes" -name '*.class')
(cd "$OUT" && jar uf base.apk classes.dex && "$BT/zipalign" -f -p 4 base.apk aligned.apk)

echo "[4/5] signing key"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -alias emilli -keyalg RSA -keysize 2048 -validity 10950 \
    -dname "CN=Emilli Remote, O=Emilli FTL, C=NL" >/dev/null 2>&1
  echo "created $KS (self-signed)"
fi

echo "[5/5] signing"
"$BT/apksigner" sign --ks "$KS" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --out "$APK" "$OUT/aligned.apk"
"$BT/apksigner" verify --print-certs "$APK" | head -4
ls -lh "$APK"
