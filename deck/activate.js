'use strict';
/**
 * Puts the Emilli keys onto the profile the deck app actually loads at startup.
 *
 * The app never writes down which profile is active (it lives in memory), so
 * importing a second profile just sits in the list. This copies the keys onto
 * the page of the profile that is already attached to the deck, after backing
 * that profile up, and leaves the imported "Emilli Subathon" profile alone.
 *
 *   node activate.js            patch the live profile
 *   node activate.js --restore  put the backed-up page back
 */
const fs = require('node:fs');
const path = require('node:path');

const HOME = process.env.HOME;
const APP = path.join(
  HOME,
  '.wine/drive_c/users/emilliftl/AppData/Roaming/Elgato/StreamDeck'
);
const PROFILES = path.join(APP, 'ProfilesV3');
const BACKUP = path.join(__dirname, '.profile-backup');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

function sources() {
  const dirs = fs.readdirSync(path.join(__dirname, 'profile'));
  const src = dirs.find((d) => d.endsWith('.sdProfile'));
  const root = path.join(__dirname, 'profile', src);
  const manifest = readJson(path.join(root, 'manifest.json'));
  const pageUuid = manifest.Pages.Current;
  const pageDir = path.join(root, 'Profiles', pageUuid.toUpperCase());
  return { root, pageDir, manifest };
}

function live() {
  const entries = fs
    .readdirSync(PROFILES)
    .filter((d) => d.endsWith('.sdProfile'))
    .map((d) => path.join(PROFILES, d));
  // Our own imported profile is the one to leave alone.
  const ours = sources().manifest.Name;
  const others = entries.filter((dir) => {
    try {
      return readJson(path.join(dir, 'manifest.json')).Name !== ours;
    } catch {
      return false;
    }
  });
  return others[0] || null;
}

function patch() {
  const src = sources();
  const target = live();
  if (!target) {
    console.error('no other profile found to patch — open the app once and retry');
    process.exit(1);
  }
  const profile = readJson(path.join(target, 'manifest.json'));
  const pageUuid = profile.Pages.Current;
  const pageDir = path.join(target, 'Profiles', pageUuid.toUpperCase());
  if (!fs.existsSync(pageDir)) {
    console.error(`page folder missing: ${pageDir}`);
    process.exit(1);
  }

  fs.rmSync(BACKUP, { recursive: true, force: true });
  fs.mkdirSync(BACKUP, { recursive: true });
  fs.copyFileSync(path.join(pageDir, 'manifest.json'), path.join(BACKUP, 'page-manifest.json'));
  fs.copyFileSync(path.join(target, 'manifest.json'), path.join(BACKUP, 'profile-manifest.json'));

  const srcActions = readJson(path.join(src.pageDir, 'manifest.json')).Controllers[0].Actions;
  const imagesSource = path.join(src.pageDir, 'Images');
  const imagesTarget = path.join(pageDir, 'Images');
  fs.mkdirSync(imagesTarget, { recursive: true });
  for (const file of fs.readdirSync(imagesSource)) {
    fs.copyFileSync(path.join(imagesSource, file), path.join(imagesTarget, file));
  }

  const page = readJson(path.join(pageDir, 'manifest.json'));
  page.Controllers = page.Controllers || [];
  if (!page.Controllers[0]) page.Controllers[0] = { Actions: {}, Type: 'Keypad' };
  page.Controllers[0].Actions = srcActions;
  page.Controllers[0].Type = 'Keypad';
  writeJson(path.join(pageDir, 'manifest.json'), page);

  console.log(`patched ${path.basename(target)} (page ${pageUuid}) with 15 Emilli keys`);
  console.log(`backup: ${BACKUP}`);
  console.log('restart the Stream Deck app to load it.');
}

function restore() {
  const target = live();
  if (!target || !fs.existsSync(path.join(BACKUP, 'page-manifest.json'))) {
    console.error('nothing to restore');
    process.exit(1);
  }
  const pageUuid = readJson(path.join(target, 'manifest.json')).Pages.Current;
  const pageDir = path.join(target, 'Profiles', pageUuid.toUpperCase());
  fs.copyFileSync(path.join(BACKUP, 'page-manifest.json'), path.join(pageDir, 'manifest.json'));
  console.log(`restored ${path.basename(target)} page ${pageUuid}`);
}

if (process.argv.includes('--restore')) restore();
else patch();
