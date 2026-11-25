/**
 * Minimal OBS WebSocket v5 client (no dependencies — Node's global WebSocket).
 *
 * Used to start/stop the stream on the timer:
 *   connect → Hello → Identify (challenge/salt auth) → requests
 *
 * Everything is best-effort: if OBS is closed the timer keeps working and the
 * dashboard just shows "OBS not connected".
 */
const crypto = require("node:crypto");

// obs-websocket v5 authenticates with SHA-256 (v4 used SHA-1).
function sha256b64(input) {
  return crypto.createHash("sha256").update(input).digest("base64");
}

function createObs(cfg, log = () => {}) {
  const client = {
    connected: false,
    authenticated: false,
    streaming: false,
    scene: null,          // program scene name, kept live from OBS events
    lastError: null,
    // Stream health for the dashboard. GetStreamStatus only reports running
    // totals, so the bitrate is derived from the byte delta between polls.
    health: {
      at: 0, ok: false, bitrateKbps: null, bytes: 0, durationMs: 0,
      skipped: 0, total: 0, congestion: 0, reconnecting: false, error: null,
    },
    reconnects: 0,        // dropped-connection episodes in this stream session
    _reconnecting: false,
    _starting: 0,         // when StartStream was last sent (see startStream)
    _ws: null,
    _pending: new Map(),
    _retry: null,
    _stopped: true,
  };

  const url = cfg.url || "ws://127.0.0.1:4455";
  const cooldownMs = 2500;

  function send(obj) {
    const ws = client._ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function connect() {
    if (client._stopped || !cfg.enabled) return;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      client.lastError = e.message;
      scheduleRetry();
      return;
    }
    client._ws = ws;

    ws.onopen = () => {
      client.connected = true;
      client.lastError = null;
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      handle(msg);
    };

          ws.onclose = () => {
        client.connected = false;
        client.authenticated = false;
        client.streaming = false;
        client.scene = null;
        scheduleRetry();
      };

    ws.onerror = () => {
      client.lastError = "could not reach OBS (is the WebSocket server enabled?)";
    };
  }

  function scheduleRetry() {
    if (client._stopped) return;
    clearTimeout(client._retry);
    client._retry = setTimeout(connect, cooldownMs);
  }

  function handle(msg) {
    switch (msg.op) {
      case 0: {
        // Hello → Identify. RequestResponse(7) | General(1) | Outputs(64)
        const auth = msg.d && msg.d.authentication;
        let authentication;
        if (auth) {
          if (!cfg.password) {
            client.lastError = "OBS requires a password (set obs.password in config.json)";
            break;
          }
          authentication = sha256b64(sha256b64(cfg.password + auth.salt) + auth.challenge);
        }
        send({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 7 | 64, authentication } });
        break;
      }
      case 2:
        client.authenticated = true;
        client.lastError = null;
        log("[obs] connected and authenticated");
        refresh();
        readProgramScene();
        break;
      case 7: {
        const req = client._pending.get(msg.d.requestId);
        if (!req) break;
        client._pending.delete(msg.d.requestId);
        clearTimeout(req.timer);
        if (msg.d.requestStatus && msg.d.requestStatus.result) {
          const data = msg.d.responseData || {};
          // Any GetSceneList also tells us the program scene.
          if (req.type === "GetSceneList" && "currentProgramSceneName" in data) {
            client.scene = data.currentProgramSceneName || null;
          }
          req.resolve(data);
        }
        else req.reject(new Error(msg.d.requestStatus?.comment || "OBS refused the request"));
        break;
      }
      case 5: {
        const ev = msg.d;
        if (ev.eventType === "StreamStateChanged" && ev.eventData) {
          client.streaming = !!ev.eventData.outputActive;
          if (client.streaming) client._starting = 0;
          // obs-websocket reports a dropped encoder connection as its own
          // state, which is the only reliable reconnect signal between polls.
          const state = String(ev.eventData.outputState || "");
          if (state === "OBS_WEBSOCKET_OUTPUT_RECONNECTING") markReconnect();
          if (state === "OBS_WEBSOCKET_OUTPUT_RECONNECTED") client._reconnecting = false;
        }
        if (ev.eventType === "ExitStarted") {
          client.authenticated = false;
          client.streaming = false;
          client.scene = null;
        }
        // Program scene switches come from the desktop app; cache them so
        // /api/state can answer without asking OBS again.
        if (ev.eventType === "CurrentProgramSceneChanged" && ev.eventData) {
          client.scene = ev.eventData.sceneName || ev.eventData.currentSceneName || null;
        }
        if (ev.eventType === "SceneNameChanged" && ev.eventData) {
          if (client.scene && client.scene === ev.eventData.oldSceneName) {
            client.scene = ev.eventData.sceneName || null;
          }
        }
        if (ev.eventType === "SceneRemoved" && ev.eventData) {
          if (client.scene && client.scene === ev.eventData.sceneName) client.scene = null;
        }
        break;
      }
      default:
        break;
    }
  }

  function request(type, data) {
    return new Promise((resolve, reject) => {
      if (!client.authenticated) {
        reject(new Error("OBS not connected"));
        return;
      }
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        client._pending.delete(requestId);
        reject(new Error(`OBS request timed out: ${type}`));
      }, 6000);
      client._pending.set(requestId, { resolve, reject, timer, type });
      send({
        op: 6,
        d: { requestType: type, requestId, ...(data ? { requestData: data } : {}) },
      });
    });
  }

  async function refresh() {
    try {
      const d = await request("GetStreamStatus");
      client.streaming = !!d.outputActive;
      applyStatus(d);
    } catch {
      /* keep last known value */
    }
    return client.streaming;
  }

  /**
   * One reconnect is one episode: OBS emits RECONNECTING once per dropped
   * socket (then RECONNECTED), and the poll sees the same flag, so the first
   * signal counts and the rest are ignored.
   */
  function markReconnect() {
    if (client._reconnecting) return;
    client._reconnecting = true;
    client.reconnects += 1;
    log(`[obs] stream reconnecting (${client.reconnects} this session)`);
  }

  /** Fold one GetStreamStatus response into the health snapshot. */
  function applyStatus(d) {
    const now = Date.now();
    if (d.outputActive) client._starting = 0;
    const prev = client.health;
    const bytes = Number(d.outputBytes || 0);
    let bitrateKbps = prev.bitrateKbps;
    // outputBytes is a running total for the session; a counter that went
    // backwards means a new session, so no rate can be derived from it.
    if (prev.at && bytes >= prev.bytes && now > prev.at) {
      const kbps = ((bytes - prev.bytes) * 8) / ((now - prev.at) / 1000) / 1000;
      if (kbps >= 0 && kbps < 100000) {
        // One poll's delta is noisy (a 3 s window of a CBR 1250 stream lands
        // anywhere from 1240 to 1550), so a lagged average is what is shown.
        bitrateKbps = Math.round(
          prev.bitrateKbps == null ? kbps : prev.bitrateKbps * 0.6 + kbps * 0.4
        );
      }
    }
    if (d.outputReconnecting) markReconnect();
    else client._reconnecting = false;
    client.health = {
      at: now,
      ok: true,
      bitrateKbps,
      bytes,
      durationMs: Number(d.outputDuration || 0),
      skipped: Number(d.outputSkippedFrames || 0),
      total: Number(d.outputTotalFrames || 0),
      congestion: Number(d.outputCongestion || 0),
      reconnecting: !!d.outputReconnecting,
      error: null,
    };
  }

  /** A new broadcast starts a new session: skipped frames and reconnects reset. */
  function resetHealth() {
    client.reconnects = 0;
    client._reconnecting = false;
    client.health = {
      at: 0, ok: false, bitrateKbps: null, bytes: 0, durationMs: 0,
      skipped: 0, total: 0, congestion: 0, reconnecting: false, error: null,
    };
  }

  async function readProgramScene() {
    try {
      const d = await request("GetCurrentProgramScene");
      client.scene = d.currentProgramSceneName || d.sceneName || null;
    } catch {
      /* events will fill it in */
    }
  }

  return {
    get connected() { return client.connected; },
    get authenticated() { return client.authenticated; },
    get streaming() { return client.streaming; },
    get scene() { return client.scene; },
    get lastError() { return client.lastError; },

    start() {
      client._stopped = false;
      if (cfg.enabled) connect();
    },

    stop() {
      client._stopped = true;
      clearTimeout(client._retry);
      try { client._ws && client._ws.close(); } catch { /* ignore */ }
    },

    // Generic OBS WebSocket request (SceneItem ops, GetSceneList, …).
    request(type, data) {
      return request(type, data);
    },

    async startStream() {
      // OBS breaks its encoder (and can take the whole app down) when a second
      // StartStream arrives while the output is still initialising, and both
      // the 15 s stream tick and a manual GO LIVE can land together. A start in
      // flight therefore blocks the next one for 15 s; every caller retries on
      // its own schedule, so nothing is lost by dropping the extra request.
      if (client._starting && Date.now() - client._starting < 15000) {
        log("[obs] StartStream already in flight — not sending another");
        return false;
      }
      client._starting = Date.now();
      await request("StartStream");
      client.streaming = true;
      log("[obs] StartStream sent");
      return true;
    },

    async stopStream() {
      await request("StopStream");
      client.streaming = false;
      log("[obs] StopStream sent");
      return true;
    },

    async status() {
      if (!client.authenticated) return null;
      try {
        const d = await request("GetStreamStatus");
        client.streaming = !!d.outputActive;
        applyStatus(d);
        return {
          streaming: !!d.outputActive,
          bitrateKbps: client.health.bitrateKbps,
          timecode: d.outputTimecode || "",
          reconnecting: !!d.outputReconnecting,
        };
      } catch {
        return null;
      }
    },

    /**
     * Fresh health snapshot for the dashboard (the timer polls this). Skipped
     * frames, bitrate and reconnects are the numbers that say whether the link
     * can carry ultra-low latency. Returns null when OBS is not connected.
     */
    async statusHealth() {
      if (!client.authenticated) return null;
      try {
        const d = await request("GetStreamStatus");
        client.streaming = !!d.outputActive;
        applyStatus(d);
      } catch (e) {
        client.health = { ...client.health, at: Date.now(), ok: false, error: e.message };
      }
      const h = client.health;
      return {
        ...h,
        reconnects: client.reconnects,
        skippedPct: h.total ? (h.skipped / h.total) * 100 : 0,
      };
    },

    resetHealth,
  };
}

module.exports = createObs;
