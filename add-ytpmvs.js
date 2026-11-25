/**
 * Adds the looping YTPMV playlist as a full-screen Browser Source at the
 * BOTTOM of a scene, so every other source (overlays, alerts, now playing)
 * draws on top of the video.
 *
 *   node add-ytpmvs.js [sceneName] [sourceName]
 */
const createObs = require("./obs");
const config = require("./config.json");

const SCENE = process.argv[2] || "camera2";
const SOURCE = process.argv[3] || "Emilli YTPMVs";
const URL_ARG = "http://localhost:8123/ytpmvs.html";
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

  let width = 1920;
  let height = 1080;
  try {
    const v = await obs.request("GetVideoSettings");
    if (v.baseWidth) width = v.baseWidth;
    if (v.baseHeight) height = v.baseHeight;
  } catch (e) {
    console.warn("could not read video settings, assuming 1920x1080:", e.message);
  }

  const settings = {
    url: URL_ARG,
    width,
    height,
    // The page is a 60 fps video player; OBS's browser default of 30 would drop
    // every other frame. Only helps if the OBS canvas runs at 60 too.
    fps_custom: true,
    fps: 60,
    shutdown: false,          // keep playing while another scene is on air
    restart_when_active: false,
    // "Control audio via OBS": the music becomes its own source in the audio
    // mixer (own fader, filters, sync offset, track assignment) instead of the
    // browser playing straight past OBS's audio system.
    reroute_audio: true,
    css: "body { background-color: #000; margin: 0px auto; overflow: hidden; }",
  };

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
    console.log(`created "${SOURCE}" in "${SCENE}"`);
  } else {
    await obs.request("SetInputSettings", { inputName: SOURCE, inputSettings: settings, overlay: true });
    console.log(`updated existing "${SOURCE}"`);
  }

  let items = (await obs.request("GetSceneItemList", { sceneName: SCENE })).sceneItems || [];
  let item = items.find((i) => i.sourceName === SOURCE);
  if (!item) {
    await obs.request("CreateSceneItem", { sceneName: SCENE, sourceName: SOURCE, sceneItemEnabled: true });
    items = (await obs.request("GetSceneItemList", { sceneName: SCENE })).sceneItems || [];
    item = items.find((i) => i.sourceName === SOURCE);
  }
  if (!item) throw new Error(`could not place "${SOURCE}" in "${SCENE}"`);

  // Full canvas, unscaled, top-left aligned.
  await obs.request("SetSceneItemTransform", {
    sceneName: SCENE,
    sceneItemId: item.sceneItemId,
    sceneItemTransform: {
      positionX: 0, positionY: 0, alignment: 5,
      boundsType: "OBS_BOUNDS_NONE", scaleX: 1, scaleY: 1, rotation: 0,
    },
  });
  await obs.request("SetSceneItemEnabled", { sceneName: SCENE, sceneItemId: item.sceneItemId, sceneItemEnabled: true });

  // OBS draws scene items in index order: index 0 is the bottom layer, the
  // highest index is on top. The video must sit at 0 so every overlay, alert
  // and the now-playing card draw over it.
  await obs.request("SetSceneItemIndex", { sceneName: SCENE, sceneItemId: item.sceneItemId, sceneItemIndex: 0 });

  const final = (await obs.request("GetSceneItemList", { sceneName: SCENE })).sceneItems || [];
  const me = final.find((i) => i.sourceName === SOURCE);
  console.log(
    "RESULT " +
      JSON.stringify(
        {
          scene: SCENE,
          source: SOURCE,
          index: me ? me.sceneItemIndex : null,
          of: final.length,
          atBottom: me ? me.sceneItemIndex === 0 : false,
          visible: me ? me.sceneItemEnabled : false,
          url: URL_ARG,
          size: `${width}x${height}`,
        },
        null,
        1
      )
  );
  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
