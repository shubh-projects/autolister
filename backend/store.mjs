import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');

const DEFAULT_DB = {
  sessions: {},
  oauthStates: {},
  connections: {},
  jobs: {},
};

let writeQueue = Promise.resolve();

async function ensureDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DB_FILE);
  } catch {
    await fs.writeFile(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2), 'utf8');
  }
}

export async function readDb() {
  await ensureDb();
  const raw = await fs.readFile(DB_FILE, 'utf8');
  try {
    return { ...DEFAULT_DB, ...JSON.parse(raw) };
  } catch {
    throw new Error('Database file is corrupted. Delete data/store.json and restart.');
  }
}

export async function updateDb(mutator) {
  writeQueue = writeQueue.then(async () => {
    const db = await readDb();
    await mutator(db);
    const tmp = `${DB_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
    await fs.rename(tmp, DB_FILE);
    return db;
  });
  return writeQueue;
}

export async function getEntity(collection, id) {
  const db = await readDb();
  return db[collection]?.[id] ?? null;
}

export async function setEntity(collection, id, value) {
  return updateDb((db) => {
    db[collection] ??= {};
    db[collection][id] = value;
  });
}

export async function deleteEntity(collection, id) {
  return updateDb((db) => {
    if (db[collection]) delete db[collection][id];
  });
}
