// Run once after pulling this update: node scripts/migrate-to-sqlite.js
//
// Reads every existing data/*.json file (if present), copies its contents
// into the new data/sangeet.db SQLite database using the exact same key
// each file's *_FILE constant resolves to in server.js, then renames the
// old file to *.json.bak so it's kept as a safety copy but no longer read
// by the app. Safe to run more than once — files already renamed to .bak
// are simply skipped.

const fs = require('fs');
const path = require('path');
const { writeJSON } = require('../db');

const DATA_DIR = path.join(__dirname, '..', 'data');

// filename -> fallback value used if the file is missing/empty (mirrors the
// fallbacks server.js passes to readJSON for each collection)
const FILES = [
  ['students.json', []],
  ['attendance.json', {}],
  ['payments.json', []],
  ['meta.json', { nextStudentId: 1 }],
  ['alert-config.json', {}],
  ['alert-state.json', {}],
  ['alert-status.json', { ranAt: null }],
  ['sync-config.json', {}],
  ['sync-status.json', { ranAt: null }]
];

async function main() {
  let migrated = 0;
  let skipped = 0;

  for (const [filename, fallback] of FILES) {
    const filePath = path.join(DATA_DIR, filename);

    if (!fs.existsSync(filePath)) {
      console.log(`- ${filename}: not found, skipping.`);
      skipped += 1;
      continue;
    }

    let data;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      data = raw.trim() ? JSON.parse(raw) : fallback;
    } catch (err) {
      console.error(`! ${filename}: could not parse as JSON (${err.message}) — leaving it untouched, not migrated.`);
      continue;
    }

    // Key must exactly match path.join(__dirname, 'data', filename) as
    // computed inside server.js, since that's what it'll look up later.
    const key = path.join(__dirname, '..', 'data', filename);
    await writeJSON(key, data);

    fs.renameSync(filePath, `${filePath}.bak`);
    console.log(`\u2713 ${filename}: migrated into sangeet.db, original kept as ${filename}.bak`);
    migrated += 1;
  }

  console.log(`\nDone. Migrated ${migrated} file(s), skipped ${skipped}.`);
  console.log('Your data now lives in data/sangeet.db — back that single file up instead of the old .json files.');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
