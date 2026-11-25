/**
 * YouTube Live Streaming API — broadcast control.
 *
 * YouTube fixes a broadcast's latency class at creation and refuses to change
 * it while the broadcast is live (contentDetails.latencyPreference is only
 * writable while status is `created` or `ready`). So the only way to move a
 * running channel from Normal to Ultra-low is:
 *
 *   end the running broadcast → insert a new one with
 *   contentDetails.latencyPreference = ultraLow → bind it to the same live
 *   stream (the encoder's stream key) → let it go live.
 *
 * OBS keeps its stream key throughout; only the broadcast changes.
 *
 * Every call needs an OAuth access token with youtube.force-ssl (see
 * yt-oauth.js) — an API key is not enough for any of this.
 *
 * Note on ultra-low: the API rejects it together with enableLowLatency, and
 * YouTube does not support it above 1080p or with closed captions.
 */
const API = "https://www.googleapis.com/youtube/v3/";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function createYtLive({ oauth, streamIdHint = "", streamName = "", log = () => {} }) {
  let cachedStreamId = streamIdHint || null;

  async function call(pathAndQuery, { method = "GET", body } = {}) {
    const token = await oauth.getAccessToken();
    const r = await fetch(API + pathAndQuery, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const first = (j.error && j.error.errors && j.error.errors[0]) || {};
      const reason = first.reason || (j.error && j.error.status) || `http ${r.status}`;
      const detail = first.message || (j.error && j.error.message) || "";
      throw new Error(detail ? `${reason}: ${detail}` : reason);
    }
    return j;
  }

  /**
   * The broadcast that is on air right now, or null.
   *
   * `broadcastStatus` cannot be combined with `mine` — YouTube answers
   * "incompatibleParameters: incompatible parameters specified in the request:
   * mine, broadcastStatus" — so the list is fetched unfiltered and the live one
   * is picked here.
   */
  async function activeBroadcast() {
    const j = await call(
      "liveBroadcasts?part=id,snippet,status,contentDetails&mine=true&maxResults=50"
    );
    const items = j.items || [];
    const onAir = items.find((b) => {
      const st = b && b.status ? String(b.status.lifeCycleStatus || "") : "";
      return st === "live" || st === "liveStarting" || st === "testing" || st === "testStarting";
    });
    log(`[yt-live] ${items.length} broadcast(s) listed, on air: ${onAir ? onAir.id : "none"}`);
    return onAir || null;
  }

  async function broadcast(id) {
    const j = await call(`liveBroadcasts?part=id,snippet,status,contentDetails&id=${encodeURIComponent(id)}`);
    return (j.items || [])[0] || null;
  }

  /**
   * The stream key OBS pushes to. One channel normally has exactly one; when
   * there are more, streamName (config.youtube.streamName) picks by title.
   */
  async function streamId() {
    if (cachedStreamId) return cachedStreamId;
    const j = await call("liveStreams?part=id,snippet,status&mine=true&maxResults=50");
    const items = j.items || [];
    if (!items.length) {
      throw new Error("no live stream (stream key) on the channel — create one once in Studio → Go live");
    }
    const wanted = String(streamName || "").toLowerCase();
    let pick = wanted
      ? items.find((s) => String((s.snippet && s.snippet.title) || "").toLowerCase().includes(wanted))
      : null;
    pick = pick || items[0];
    cachedStreamId = pick.id;
    log(`[yt-live] stream key "${(pick.snippet && pick.snippet.title) || pick.id}" (${pick.id})`);
    return cachedStreamId;
  }

  /** End a broadcast. This closes its ingest session; OBS reconnects by itself. */
  async function endBroadcast(id) {
    return call(`liveBroadcasts/transition?broadcastStatus=complete&id=${encodeURIComponent(id)}`, {
      method: "POST",
    });
  }

  /** Wait until the broadcast is really over, so a new one can take its place. */
  async function waitGone(id, timeoutMs = 25000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const b = await broadcast(id);
      const st = b && b.status ? b.status.lifeCycleStatus : null;
      if (!st || st === "complete" || st === "revoked") return true;
      await pause(1500);
    }
    return false;
  }

  /**
   * latencyPreference body. ultraLow must NOT set enableLowLatency — the API
   * rejects the pair as invalidLatencyPreferenceOptions.
   */
  function latencyBody(pref) {
    if (pref === "ultraLow") return { latencyPreference: "ultraLow" };
    if (pref === "low") return { latencyPreference: "low", enableLowLatency: true };
    return { latencyPreference: "normal", enableLowLatency: false };
  }

  /**
   * Create a broadcast that starts by itself as soon as the encoder's stream
   * goes active, and stops itself about a minute after the encoder stops — the
   * same behaviour the channel had in Studio.
   */
  async function createBroadcast({ latency = "ultraLow", title, description, privacyStatus = "public", categoryId, startTime, dvr = false } = {}) {
    const body = {
      snippet: {
        title: title || "Emilli FTL — live",
        ...(description ? { description: String(description).slice(0, 5000) } : {}),
        scheduledStartTime: new Date(startTime || Date.now()).toISOString(),
        ...(categoryId ? { categoryId: String(categoryId) } : {}),
      },
      status: { privacyStatus: privacyStatus || "public" },
      contentDetails: {
        enableAutoStart: true,
        enableAutoStop: true,
        // DVR is what forces the player into its big buffer: with enableDvr the
        // live edge sits ~20 s back no matter what latencyPreference says. Off
        // by default, because the whole point of this switch is minimum delay.
        enableDvr: !!dvr,
        ...latencyBody(latency),
      },
    };
    return call("liveBroadcasts?part=snippet,status,contentDetails", { method: "POST", body });
  }

  /**
   * Change the title and/or description of a broadcast. Works while it is live
   * — YouTube allows snippet edits on air — and the snippet needs its
   * scheduledStartTime back, so the current one is echoed in.
   */
  async function updateBroadcast(id, { title, description } = {}) {
    const cur = await broadcast(id);
    if (!cur) throw new Error("no such broadcast");
    const sn = cur.snippet || {};
    const body = {
      id,
      snippet: {
        title: title == null ? sn.title || "" : String(title).slice(0, 100),
        description: description == null ? sn.description || "" : String(description).slice(0, 5000),
        ...(sn.scheduledStartTime ? { scheduledStartTime: sn.scheduledStartTime } : {}),
        ...(sn.categoryId ? { categoryId: String(sn.categoryId) } : {}),
      },
    };
    const out = await call("liveBroadcasts?part=snippet", { method: "PUT", body });
    log(`[yt-live] ${id} snippet updated`);
    return (out && out.items && out.items[0]) || out;
  }

  /**
   * Post a message into the live chat as the channel owner. The public API has
   * no "pin" call — pinning is a Studio-only action — so this is the best the
   * API can do; the app says so instead of pretending.
   */
  async function sendChat(broadcastId, text) {
    const b = await broadcast(broadcastId);
    const liveChatId = b && b.snippet ? b.snippet.liveChatId : null;
    if (!liveChatId) throw new Error("this broadcast has no live chat");
    const body = {
      snippet: {
        type: "textMessageEvent",
        liveChatId,
        textMessageDetails: { messageText: String(text).slice(0, 200) },
      },
    };
    return call("liveChat/messages?part=snippet,authorDetails", { method: "POST", body });
  }

  /** Attach the broadcast to a stream key. The key itself is unchanged. */
  async function bind(broadcastId, stream) {
    return call(
      `liveBroadcasts/bind?part=id,contentDetails&id=${encodeURIComponent(broadcastId)}&streamId=${encodeURIComponent(stream)}`,
      { method: "POST" }
    );
  }

  async function goLive(broadcastId) {
    return call(`liveBroadcasts/transition?broadcastStatus=live&id=${encodeURIComponent(broadcastId)}`, {
      method: "POST",
    });
  }

  async function streamStatus(id) {
    const j = await call(`liveStreams?part=id,status&id=${encodeURIComponent(id || cachedStreamId)}`);
    const item = (j.items || [])[0] || {};
    return (item.status && item.status.streamStatus) || null;
  }

  /**
   * Wait for the broadcast to be live. enableAutoStart normally does it on its
   * own; if the ingest was already active before the bind, the transition
   * never fires, so nudge it a few times. Returns the live broadcast resource,
   * whose contentDetails.latencyPreference is the class YouTube actually used.
   */
  async function waitForLive(id, { timeoutMs = 90000 } = {}) {
    const until = Date.now() + timeoutMs;
    let nudges = 0;
    let last = null;
    while (Date.now() < until) {
      last = await broadcast(id);
      const st = last && last.status ? last.status.lifeCycleStatus : null;
      if (st === "live" || st === "liveStarting") return last;
      if (st === "complete" || st === "revoked") {
        throw new Error(`the new broadcast ended itself (${st}) — check OBS is still streaming`);
      }
      if (nudges < 4) {
        try {
          if ((await streamStatus(cachedStreamId)) === "active") {
            nudges += 1;
            await goLive(id);
          }
        } catch (e) {
          log(`[yt-live] transition to live: ${e.message}`);
        }
      }
      await pause(3000);
    }
    throw new Error(
      `the new broadcast did not go live in ${Math.round(timeoutMs / 1000)}s (obs ${last && last.status ? last.status.lifeCycleStatus : "unknown"})`
    );
  }

  return {
    activeBroadcast,
    broadcast,
    updateBroadcast,
    sendChat,
    streamId,
    endBroadcast,
    waitGone,
    createBroadcast,
    bind,
    goLive,
    streamStatus,
    waitForLive,
    latencyBody,
  };
}

module.exports = createYtLive;
