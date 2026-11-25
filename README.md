# YTLiveDash

Everything behind the 24h subathon stream: the timer server, the browser dashboard,
the OBS overlay and the Android remote.

- **Timer / dashboard** — `node server.js`, dashboard on `http://127.0.0.1:8123/`,
  phone remote on `/mobile.html`, OBS overlay on `/overlay.html`.
- **Ultra-low latency** — the timer owns the broadcast (title, description,
  `latencyPreference=ultraLow`, DVR off) and re-checks the class after every go-live.
- **Pinned chat note** — YouTube's API cannot pin a message, so the dashboard keeps
  the text, posts it as the channel on demand or on every go-live, and links to the
  Studio tab where the Pin button lives.
- **APK** — `android/build-apk.sh` builds and signs the remote without Gradle.

## Run it

```bash
cp config.example.json config.json   # then fill in the keys
node server.js
```

Zero dependencies. `sounds/`, the tunnel binary and every generated file are local
only; nothing else is needed to start.

## Secrets

`config.json` is **not** in the repo — it holds the YouTube API key, the OAuth
client secret, the Ko-fi token, the remote access token and the OBS/VLC passwords.
Copy `config.example.json` and fill it in.

## Building the APK

```bash
echo 'your-keystore-password' > android/.ks-pass   # once, never committed
./android/build-apk.sh                             # → emilli-remote.apk
```

Needs Android build-tools 35.0.0 and platform 35 (`ANDROID_HOME`). By default the
build bakes in the current tunnel URL **with the access token** — fine for the copy
this machine serves, never for a copy you hand out. Pass `EMILLI_DEFAULT_URL` to
ship a token-free build:

```bash
EMILLI_DEFAULT_URL="http://192.168.100.73:8123/mobile.html" ./android/build-apk.sh
```

## Releases

Pushing a tag runs `.github/workflows/apk.yml`, which builds the APK on a clean
runner and attaches it to a GitHub release:

```bash
git tag v3.9 && git push origin v3.9
```

The workflow needs two repo secrets: `ANDROID_KEYSTORE_B64` (base64 of
`android/emilli-release.keystore`) and `ANDROID_KEYSTORE_PASS`. Same key, same
signature, so the update installs over the copy already on the phone.
