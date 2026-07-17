// All app data lives in one SQLite-shaped store: a `store` table where every
// collection (students, attendance, payments, alert/sync config & state) is
// one JSON blob per row, addressed by key. The rest of server.js only ever
// calls readJSON(SOME_FILE, fallback) / writeJSON(SOME_FILE, data) — it has
// no idea which of the two backends below is actually behind those calls.
//
// Two backends, chosen automatically:
//
//  1. Local file (better-sqlite3) — the default. Used whenever
//     TURSO_DATABASE_URL isn't set, e.g. running on your own machine, or on
//     a host with a real persistent disk (a mounted Render Disk, a VPS,
//     etc). Fast, zero setup, but the file itself must live somewhere that
//     survives restarts — which a host's default filesystem often doesn't.
//
//  2. Turso (libSQL) — used when TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN)
//     are set. This is what lets the app run on a host with NO persistent
//     disk at all — like Render's free web service tier — since the actual
//     database lives on Turso's free managed service instead of the local
//     filesystem. Nothing else about the app changes; every read/write just
//     goes over the network instead of to a local file.

const useTurso = !!process.env.TURSO_DATABASE_URL;

let readJSON, writeJSON;

if (useTurso) {
  // ---- Turso (libSQL) backend ----
  const { createClient } = require('@libsql/client');
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
  });

  const ready = client.execute(`
    CREATE TABLE IF NOT EXISTS store (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  readJSON = async function readJSON(key, fallback) {
    await ready;
    const result = await client.execute({ sql: 'SELECT value FROM store WHERE key = ?', args: [key] });
    if (!result.rows.length) return fallback;
    try {
      return JSON.parse(result.rows[0].value);
    } catch (err) {
      console.error(`Corrupted JSON in store for key "${key}", using fallback:`, err.message);
      return fallback;
    }
  };

  writeJSON = async function writeJSON(key, data) {
    await ready;
    await client.execute({
      sql: `INSERT INTO store (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [key, JSON.stringify(data), new Date().toISOString()]
    });
  };
} else {
  // ---- Local file (better-sqlite3) backend ----
  const path = require('path');
  const fs = require('fs');
  const Database = require('better-sqlite3');

  // On a host with an ephemeral filesystem, anything written to a plain
  // local path like ./data is wiped on every deploy and every restart.
  // Setting DATA_DIR to a mounted persistent disk's path keeps the
  // database across deploys. Left unset, it defaults to the same ./data
  // folder used in local development, so nothing changes for anyone
  // running this on their own machine.
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const DB_PATH = path.join(DATA_DIR, 'sangeet.db');
  const db = new Database(DB_PATH);

  // WAL = Write-Ahead Logging. Lets reads happen concurrently with writes
  // instead of locking the whole database, and survives a crash mid-write
  // without corrupting the file.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS store (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const getStmt = db.prepare('SELECT value FROM store WHERE key = ?');
  const setStmt = db.prepare(`
    INSERT INTO store (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  // Kept async so every existing "await readJSON(...)" / "await writeJSON(...)"
  // call site in server.js keeps working unchanged — awaiting a plain
  // (non-Promise) value is valid JS and resolves immediately.
  readJSON = async function readJSON(key, fallback) {
    const row = getStmt.get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch (err) {
      console.error(`Corrupted JSON in store for key "${key}", using fallback:`, err.message);
      return fallback;
    }
  };

  writeJSON = async function writeJSON(key, data) {
    setStmt.run(key, JSON.stringify(data), new Date().toISOString());
  };
}

module.exports = { readJSON, writeJSON };
