'use strict';
/**
 * Builds the Elgato Stream Deck profile that ships with the Emilli Timer
 * plugin: one page, 15 keys, every control the long stream needs.
 *
 *   node build-profile.js
 *
 * Writes deck/profile/<UUID>.sdProfile (folder) and
 * deck/Emilli Subathon.streamDeckProfile (zip, for Import in the app).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('./draw');

const DEVICE = { Model: '20GBA9901', UUID: '@(1)[4057/128/A00SA5452JD6DK]' };
// Read from the live profile when possible: the deck's own device string.
function device() {
  const home = process.env.HOME;
  const profiles = path.join(
    home,
    '.wine/drive_c/users/emilliftl/AppData/Roaming/Elgato/StreamDeck/ProfilesV3'
  );
  try {
    for (const entry of fs.readdirSync(profiles)) {
      if (!entry.endsWith('.sdProfile')) continue;
      const man = JSON.parse(fs.readFileSync(path.join(profiles, entry, 'manifest.json'), 'utf8'));
      if (man.Device && man.Device.UUID) return man.Device;
    }
  } catch {
    /* fall back to the default below */
  }
  return DEVICE;
}

const C = {
  bg: [11, 11, 17],
  edge: [42, 42, 54],
  txt: [244, 244, 247],
  dim: [141, 141, 155],
};

const TONES = {
  go: { bg: [18, 38, 32], edge: [46, 122, 92], txt: [200, 255, 230] },
  stop: { bg: [30, 12, 19], edge: [122, 35, 51], txt: [255, 208, 216] },
  sub: { bg: [17, 17, 25], edge: [92, 32, 46], txt: [255, 107, 133] },
  kofi: { bg: [17, 17, 25], edge: [30, 80, 105], txt: [92, 200, 242] },
  like: { bg: [17, 17, 25], edge: [92, 56, 32], txt: [255, 167, 107] },
  dim: { bg: [17, 17, 25], edge: [42, 42, 54], txt: [244, 244, 247] },
};

// index → [kind, label, sub, tone]
const KEYS = [
  ['timer', 'TIMER', '--:--', 'dim'],
  ['go', 'GO LIVE', 'OBS', 'go'],
  ['stop', 'END', 'STREAM', 'stop'],
  ['undo', 'UNDO', 'LAST', 'dim'],
  ['sync', 'SYNC', 'YOUTUBE', 'dim'],
  ['sub', 'SUB', '+5:00', 'sub'],
  ['kofi', 'KO-FI', '+30:00', 'kofi'],
  ['like', 'LIKE', '+0:30', 'like'],
  ['start', 'START', 'NOW', 'dim'],
  ['mute', 'MUSIC', 'MUTE', 'dim'],
  ['voldown', 'VOL', '-3 DB', 'dim'],
  ['volup', 'VOL', '+3 DB', 'dim'],
  ['scene', 'SCENE', 'NEXT', 'dim'],
  ['sceneprev', 'SCENE', 'PREV', 'dim'],
  ['stats', 'STATS', 'LIVE', 'dim'],
];

function keyImage(label, sub, toneName) {
  const tone = TONES[toneName] || TONES.dim;
  const c = D.canvas(72, 72);
  D.roundRect(c, 0, 0, 72, 72, 10, tone.bg);
  D.stroke(c, 0, 0, 72, 72, 10, 1, tone.edge || C.edge);
  if (label) D.textCenter(c, label, sub ? 18 : 30, 2, tone.txt);
  if (sub) D.textCenter(c, sub, 50, 2, C.dim);
  return c;
}

function main() {
  const profileUuid = crypto.randomUUID().toUpperCase();
  const pageUuid = crypto.randomUUID().toLowerCase();
  // The app keeps a separate fallback page outside the page list; reusing a
  // real page id here makes it refuse the mapping ("duplicate").
  const defaultPageUuid = crypto.randomUUID().toLowerCase();
  const root = path.join(__dirname, 'profile', `${profileUuid}.sdProfile`);
  const pageDir = path.join(root, 'Profiles', pageUuid.toUpperCase());
  fs.rmSync(path.join(__dirname, 'profile'), { recursive: true, force: true });
  fs.mkdirSync(path.join(pageDir, 'Images'), { recursive: true });

  const actions = {};
  KEYS.forEach(([kind, label, sub, tone], index) => {
    const actionId = crypto.randomUUID();
    const imageName = `${kind.toUpperCase()}.png`;
    fs.writeFileSync(path.join(pageDir, 'Images', imageName), D.toPNG(keyImage(label, sub, tone)));
    const col = index % 5;
    const row = Math.floor(index / 5);
    actions[`${row},${col}`] = {
      ActionID: actionId,
      LinkedTitle: true,
      Name: 'Stream Control',
      Plugin: { Name: 'Emilli Timer', UUID: 'com.emilli.timer', Version: '1.0.0' },
      Resources: null,
      Settings: { kind },
      State: 0,
      States: [
        {
          FontFamily: '',
          FontSize: 12,
          FontStyle: '',
          FontUnderline: false,
          Image: `Images/${imageName}`,
          OutlineThickness: 2,
          ShowTitle: false,
          Title: '',
          TitleAlignment: 'bottom',
          TitleColor: '#ffffff',
        },
      ],
      UUID: 'com.emilli.timer.key',
    };
  });

  fs.writeFileSync(
    path.join(pageDir, 'manifest.json'),
    JSON.stringify({ Controllers: [{ Actions: actions, Type: 'Keypad' }], Icon: '', Name: '' })
  );

  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      Device: device(),
      Name: 'Emilli Subathon',
      Pages: { Current: pageUuid, Default: defaultPageUuid, Pages: [pageUuid] },
      Version: '3.0',
    })
  );

  // A zip with the profile at its root, ready for Stream Deck → Import.
  const staging = path.join(__dirname, 'profile');
  const zip = path.join(__dirname, 'Emilli Subathon.streamDeckProfile');
  fs.rmSync(zip, { force: true });
  require('node:child_process').execFileSync('jar', ['cfM', zip, '-C', staging, '.'], {
    stdio: 'inherit',
  });

  console.log(`profile folder: ${root}`);
  console.log(`profile zip:    ${zip}`);
  console.log(`keys: ${KEYS.length}, page uuid ${pageUuid}`);
}

main();
