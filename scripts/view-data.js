// Run any time you want to look at your data in plain, readable JSON:
//   node scripts/view-data.js
//
// This does NOT touch the live database — it only reads from it and writes
// clean copies into data/export/. Safe to run as often as you like; each
// run just overwrites the previous export.

const fs = require('fs');
const path = require('path');
const { readJSON } = require('../db');

const DATA_DIR = path.join(__dirname, '..', 'data');
const EXPORT_DIR = path.join(DATA_DIR, 'export');

// Same filename -> fallback pairing used everywhere else in the app.
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
  fs.mkdirSync(EXPORT_DIR, { recursive: true });

  for (const [filename, fallback] of FILES) {
    // Must match the exact key server.js uses: path.join(__dirname, 'data', filename)
    const key = path.join(__dirname, '..', 'data', filename);
    const data = await readJSON(key, fallback);
    const outPath = path.join(EXPORT_DIR, filename);
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf-8');
    const count = Array.isArray(data) ? `${data.length} record(s)` : `${Object.keys(data).length} key(s)`;
    console.log(`- ${filename}: ${count} \u2192 data/export/${filename}`);
  }

  console.log(`\nDone. Open the files inside data/export/ with any text editor to read them.`);
}

main().catch((err) => {
  console.error('Export failed:', err);
  process.exit(1);
});
