/**
 * Minimal OAuth 2.0 for the YouTube Data API.
 *
 * The public API only ever reports a rounded subscriber total, so the one way
 * to see who actually subscribed is subscriptions.list with
 * myRecentSubscribers=true — and that needs the channel owner's permission.
 * The same token also lets yt-live.js end and create the channel's broadcasts.
 * This module holds the client credentials, the consent URL and the refresh
 * token exchange. It has no dependencies.
 *
 * Token file holds a refresh token: keep it out of any public asset or repo.
 */
const fs = require("node:fs");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
// force-ssl is the narrowest scope that can both read subscribers and manage
// liveBroadcasts (transition/bind/insert). readonly could only read.
const SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";

function createYtOAuth({ clientId = "", clientSecret = "", redirectUri, tokenFile }) {
  let tokens = null;
  try {
    tokens = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  } catch {
    tokens = null;
  }

  const configured = () => Boolean(clientId && clientSecret);
  const hasToken = () => Boolean(tokens && tokens.refresh_token);

  function writeTokens(next) {
    tokens = next;
    try {
      fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    } catch (e) {
      console.error("[yt-oauth] could not save token file:", e.message);
    }
  }

  /** URL to send the channel owner to. access_type/prompt force a refresh token. */
  function authUrl(state) {
    const u = new URL(AUTH_URL);
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", SCOPE);
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("include_granted_scopes", "true");
    if (state) u.searchParams.set("state", state);
    return u.toString();
  }

  async function tokenRequest(body) {
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(j.error_description || j.error || `token endpoint returned ${r.status}`);
    }
    return j;
  }

  /** Trade the ?code= from the callback for an access + refresh token. */
  async function exchange(code) {
    const j = await tokenRequest({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    writeTokens({
      refresh_token: j.refresh_token || (tokens && tokens.refresh_token) || null,
      access_token: j.access_token,
      expires_at: Date.now() + Math.max(30, Number(j.expires_in || 3600) - 60) * 1000,
      scope: j.scope || SCOPE,
      connectedAt: Date.now(),
    });
    return tokens;
  }

  /** A usable access token, refreshed from the stored refresh token if stale. */
  async function getAccessToken() {
    if (!tokens || !tokens.refresh_token) {
      throw new Error("YouTube is not authorized yet — open http://localhost:8123/oauth/start");
    }
    if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at) {
      return tokens.access_token;
    }
    let j;
    try {
      j = await tokenRequest({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokens.refresh_token,
        grant_type: "refresh_token",
      });
    } catch (e) {
      // A consent screen left in "Testing" hands out refresh tokens that die
      // after 7 days. Say what to do instead of failing as "invalid_grant".
      if (/invalid_grant|expired or revoked/i.test(e.message)) {
        throw new Error(
          "YouTube authorization expired — publish the OAuth consent screen (or re-authorize at /oauth/start)"
        );
      }
      throw e;
    }
    writeTokens({
      ...tokens,
      access_token: j.access_token,
      expires_at: Date.now() + Math.max(30, Number(j.expires_in || 3600) - 60) * 1000,
    });
    return tokens.access_token;
  }

  function disconnect() {
    tokens = null;
    try {
      fs.unlinkSync(tokenFile);
    } catch { /* already gone */ }
  }

  return { configured, hasToken, authUrl, exchange, getAccessToken, disconnect, tokenFile };
}

module.exports = createYtOAuth;
