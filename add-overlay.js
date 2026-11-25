/**
 * Adds (or updates) the timer overlay as a Browser Source in an OBS scene.
 *
 *   node add-overlay.js [url] [sceneName] [sourceName]
 *
 * Uses the OBS WebSocket connection configured in config.json (obs.*).
 */
const createObs = require("./obs");
const config = require("./config.json");

const URL_ARG = process.argv[2] || "http://localhost:8123/overlay.html";
const SCENE = process.argv[3] || "Game";
const SOURCE = process.argv[4] || "Emilli 24h Overlay";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const obs = createObs({ ...config.obs, enabled: true }, (m) => console.log(m));
obs.start();

(async () => {
  for (let i = 0; i < 60; i++) {
    if (obs.authenticated) break;
    await sleep(250);
  }
  if (!obs.authenticated) {
    console.error("FAILED: could not authenticate to OBS —", obs.lastError || "no connection");
    process.exit(1);
  }

  let baseWidth = 1920;
  let baseHeight = 1080;
  try {
    const v = await obs.request("GetVideoSettings");
    if (v.baseWidth) baseWidth = v.baseWidth;
    if (v.baseHeight) baseHeight = v.baseHeight;
  } catch (e) {
    console.warn("could not read video settings, assuming 1920x1080:", e.message);
  }
  console.log(`canvas: ${baseWidth}x${baseHeight}, target scene: "${SCENE}"`);

  const settings = {
    url: URL_ARG,
    width: baseWidth,
    height: baseHeight,
    fps_custom: false,
    fps: 30,
    shutdown: false,
    restart_when_active: false,
    // OBS's own default: transparent background, no margins, no scrollbars.
    css: "body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }",
  };

  // Does the input already exist anywhere?
  const all = await obs.request("GetInputList");
  const exists = (all.inputs || []).some((i) => i.inputName === SOURCE);

  if (!exists) {
    await obs.request("CreateInput", {
      sceneName: SCENE,
      inputName: SOURCE,
      inputKind: "browser_source",
      inputSettings: settings,
      sceneItemEnabled: true,
    });
    console.log(`created input "${SOURCE}" and added it to "${SCENE}"`);
  } else {
    await obs.request("SetInputSettings", {
      inputName: SOURCE,
      inputSettings: settings,
      overlay: true,
    });
    console.log(`updated existing input "${SOURCE}"`);
  }

  // Make sure it is actually a scene item in the target scene (an input can
  // exist without being used in a scene).
  const items = await obs.request("GetSceneItemList", { sceneName: SCENE });
  const present = (items.sceneItems || []).some((i) => i.sourceName === SOURCE);
  if (!present) {
    await obs.request("CreateSceneItem", {
      sceneName: SCENE,
      sourceName: SOURCE,
      sceneItemEnabled: true,
    });
    console.log(`added "${SOURCE}" as a scene item in "${SCENE}"`);
  }

  // Place it exactly over the canvas, unscaled.
  const after = await obs.request("GetSceneItemList", { sceneName: SCENE });
  const item = (after.sceneItems || []).find((i) => i.sourceName === SOURCE);
  if (item) {
    try {
      await obs.request("SetSceneItemTransform", {
        sceneName: SCENE,
        sceneItemId: item.sceneItemId,
        sceneItemTransform: {
          positionX: 0,
          positionY: 0,
          alignment: 5, // top-left
          boundsType: "OBS_BOUNDS_NONE",
          scaleX: 1,
          scaleY: 1,
          rotation: 0,
        },
      });
      await obs.request("SetSceneItemEnabled", {
        sceneName: SCENE,
        sceneItemId: item.sceneItemId,
        sceneItemEnabled: true,
      });
    } catch (e) {
      console.warn("transform/visibility tweak failed (not fatal):", e.message);
    }
    // Only take the program scene when explicitly asked, so adding a source
    // to a non-active scene does not switch what is on air.
    if (process.env.SET_SCENE === "1") {
      // obs-websocket 5.7 renamed SetCurrentScene → SetCurrentProgramScene.
      await obs
        .request("SetCurrentProgramScene", { sceneName: SCENE })
        .catch(() => obs.request("SetCurrentScene", { sceneName: SCENE }).catch(() => {}));
    }
  }

  // Report the final truth from OBS, not from what we intended.
  const finalItems = await obs.request("GetSceneItemList", { sceneName: SCENE });
  const set = await obs.request("GetInputSettings", { inputName: SOURCE });
  const present2 = (finalItems.sceneItems || []).find((i) => i.sourceName === SOURCE);
  console.log("RESULT", JSON.stringify({
    scene: SCENE,
    source: SOURCE,
    sceneItemId: present2 ? present2.sceneItemId : null,
    visible: present2 ? present2.sceneItemEnabled : false,
    url: set.inputSettings && set.inputSettings.url,
    width: set.inputSettings && set.inputSettings.width,
    height: set.inputSettings && set.inputSettings.height,
    css: set.inputSettings && set.inputSettings.css,
    sceneItemCount: (finalItems.sceneItems || []).length,
  }, null, 1));

  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
