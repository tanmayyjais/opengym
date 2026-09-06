/* api/storage.js
 * Persistent key-value storage abstraction for openGym.
 *
 * Cloud mode  (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set):
 *   → Upstash Redis via its HTTP REST API. No extra npm dependencies.
 *     Free tier: 10 000 commands/day, 256 MB — more than enough for personal use.
 *
 * Local/Docker mode (env vars not set):
 *   → Plain JSON files inside DATA_DIR, exactly as the original code did.
 *
 * Public API:
 *   kvGet(key)         → Promise<any | null>
 *   kvSet(key, value)  → Promise<void>
 *   kvSetBg(key, value)→ void  (fire-and-forget, logs errors)
 *   useKV              → boolean  (true when using Upstash)
 *   DATA_DIR           → string   (relevant only in local mode)
 */

import fs from 'node:fs';
import path from 'node:path';

const KV_URL   = process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export const DATA_DIR = process.env.DATA_DIR || '/data';
export const useKV = !!(KV_URL && KV_TOKEN);

if (!useKV) {
  // Local filesystem: ensure data directory exists and is private.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { fs.chmodSync(DATA_DIR, 0o700); } catch { /* host fs may refuse — carry on */ }
}

// ----- Upstash Redis REST helper ----------------------------------------

async function upstash(...args) {
  // Upstash REST accepts Redis commands as a JSON array in the POST body.
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`Upstash: ${j.error}`);
  return j.result;
}

// ----- Local filesystem helper ------------------------------------------

function localPath(key) {
  // Map "db", "vapid", "secret", "state:uid-123" → safe filenames.
  const safe = key.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(DATA_DIR, safe);
}

// ----- Public API -------------------------------------------------------

/**
 * Read a value by key. Returns parsed JSON, or null if not found.
 */
export async function kvGet(key) {
  if (useKV) {
    const raw = await upstash('GET', key);
    if (raw === null || raw === undefined) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  }
  try {
    return JSON.parse(fs.readFileSync(localPath(key), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write a value. Strings are stored as-is; anything else is JSON-stringified.
 */
export async function kvSet(key, value) {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (useKV) {
    await upstash('SET', key, str);
    return;
  }
  // Atomic write: write to tmp then rename so readers never see a partial file.
  const file = localPath(key);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, str);
  fs.renameSync(tmp, file);
}

/**
 * Fire-and-forget write. Logs errors but never throws.
 * Use for saves that must not block an in-flight HTTP response.
 */
export function kvSetBg(key, value) {
  kvSet(key, value).catch(err =>
    console.error(`[storage] kvSetBg failed for "${key}":`, err.message)
  );
}
