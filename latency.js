#!/usr/bin/env node
// Puts the latency clock on every OBS scene (top layer) or takes it away again,
// so a stream measurement survives scene switches.
//   node latency.js on
//   node latency.js off
//   node latency.js status
const cfg = require('./config.json');
const createObs = require('./obs.js');

const NAME = 'Latency clock';
const action = process.argv[2] || 'status';

const obs = createObs({ ...cfg.obs, enabled: true }, (m) => {
  if (!/authenticated|connected/.test(m)) console.log(m);
});
obs.start();

const started = Date.now();
const wait = setInterval(async () => {
  if (!obs.authenticated) {
    if (Date.now() - started > 8000) {
      console.log('OBS did not authenticate');
      process.exit(1);
    }
    return;
  }
  clearInterval(wait);
  try {
    await run();
  } catch (e) {
    console.log('error:', e.message);
  }
  obs.stop();
  process.exit(0);
}, 200);

async function ensureSource() {
  try {
    await obs.request('GetInputSettings', { inputName: NAME });
  } catch {
    await obs.request('CreateInput', {
      sceneName: (await obs.request('GetCurrentProgramScene')).currentProgramSceneName,
      inputName: NAME,
      inputKind: 'browser_source',
      inputSettings: {
        url: 'http://127.0.0.1:8123/latency-clock.html',
        width: 1920,
        height: 1080,
        css: 'body { background: transparent; }',
      },
      sceneItemEnabled: false,
    });
    console.log('created browser source', NAME);
  }
}

async function run() {
  const { scenes } = await obs.request('GetSceneList');
  const names = (scenes || []).map((s) => s.sceneName);
  const current = (await obs.request('GetCurrentProgramScene')).currentProgramSceneName;

  if (action === 'status') {
    for (const scene of names) {
      const { sceneItems } = await obs.request('GetSceneItemList', { sceneName: scene });
      const item = (sceneItems || []).find((i) => i.sourceName === NAME);
      console.log(`${scene}: ${item ? (item.sceneItemEnabled ? 'visible' : 'present, hidden') : 'absent'}${scene === current ? '  <- live' : ''}`);
    }
    return;
  }

  await ensureSource();

  for (const scene of names) {
    const { sceneItems } = await obs.request('GetSceneItemList', { sceneName: scene });
    let item = (sceneItems || []).find((i) => i.sourceName === NAME);
    if (!item) {
      if (action !== 'on') continue;
      const created = await obs.request('CreateSceneItem', { sceneName: scene, sourceName: NAME, sceneItemEnabled: true });
      item = { sceneItemId: created.sceneItemId, sceneItemIndex: -1 };
    }
    await obs.request('SetSceneItemEnabled', { sceneName: scene, sceneItemId: item.sceneItemId, sceneItemEnabled: action === 'on' });
    if (action === 'on') {
      const { sceneItems: after } = await obs.request('GetSceneItemList', { sceneName: scene });
      const top = (after || []).length - 1;
      await obs.request('SetSceneItemIndex', { sceneName: scene, sceneItemId: item.sceneItemId, sceneItemIndex: top });
    }
    console.log(`${scene}: ${action === 'on' ? 'on top' : 'hidden'}`);
  }
}
