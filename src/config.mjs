import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.join(__dirname, '..');

function loadDotEnv() {
  const envPath = path.join(PROJECT_ROOT, '.env');
  const vars = {};
  if (!fs.existsSync(envPath)) return vars;
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [k, ...v] = trimmed.split('=');
    if (k && v.length) {
      vars[k.trim()] = v.join('=').trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return vars;
}

const dotEnv = loadDotEnv();

/** Real environment variables win over values from the local .env file. */
export function env(key) {
  const value = process.env[key] ?? dotEnv[key];
  return value === undefined || value === '' ? undefined : value;
}

function parseJsonEnv(key) {
  const raw = env(key);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${key} is not valid JSON: ${err.message}`);
  }
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function normalizeName(name) {
  return String(name || '').toLowerCase().trim();
}

/**
 * Instances come from HA_INSTANCES_JSON, e.g.
 *   {"home": {"url": "http://homeassistant.local:8123", "token": "...", "aliases": ["house"]}}
 * or, if that is unset, from HA_URL + HA_TOKEN as a single instance named "default".
 */
function loadInstances() {
  const instances = {};
  const json = parseJsonEnv('HA_INSTANCES_JSON');

  if (json !== undefined) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new Error('HA_INSTANCES_JSON must be a JSON object: {"name": {"url": "...", "token": "..."}}');
    }
    for (const [rawName, conf] of Object.entries(json)) {
      const name = normalizeName(rawName);
      if (!conf || typeof conf.url !== 'string' || !conf.url) {
        throw new Error(`HA_INSTANCES_JSON["${rawName}"] is missing a "url" string`);
      }
      instances[name] = {
        url: conf.url,
        token: typeof conf.token === 'string' ? conf.token : '',
        aliases: Array.isArray(conf.aliases) ? conf.aliases.map(normalizeName) : []
      };
    }
  } else if (env('HA_URL')) {
    instances.default = { url: env('HA_URL'), token: env('HA_TOKEN') || '', aliases: [] };
  }

  return instances;
}

export const INSTANCES = loadInstances();
export const INSTANCE_NAMES = Object.keys(INSTANCES);
export const DEFAULT_INSTANCE = normalizeName(env('HA_DEFAULT_INSTANCE')) || INSTANCE_NAMES[0] || null;

export function resolveInstance(instance = null) {
  if (!INSTANCE_NAMES.length) {
    throw new Error('No Home Assistant instance configured. Set HA_INSTANCES_JSON or HA_URL + HA_TOKEN.');
  }
  const wanted = normalizeName(instance) || DEFAULT_INSTANCE;
  for (const [name, conf] of Object.entries(INSTANCES)) {
    if (name === wanted || conf.aliases.includes(wanted)) {
      return { name, url: conf.url, token: conf.token };
    }
  }
  throw new Error(`Unknown Home Assistant instance "${instance}". Configured: ${INSTANCE_NAMES.join(', ')}`);
}

// Optional locale/timezone used to add *_local timestamps to history results.
export const DISPLAY_LOCALE = env('HA_LOCALE');
export const DISPLAY_TIMEZONE = env('HA_TIMEZONE');
// Fail fast on an invalid locale/timezone instead of erroring on every history call.
new Intl.DateTimeFormat(DISPLAY_LOCALE, { timeZone: DISPLAY_TIMEZONE });

export const CAMERA_WATCHES_PATH = expandHome(
  env('HA_CAMERA_WATCHES_PATH') || path.join(PROJECT_ROOT, 'data', 'camera_watches.json')
);

/** Map of NVR channel number -> camera name, e.g. {"1": "Front Door", "2": "Backyard"}. */
function loadCameraChannels() {
  const json = parseJsonEnv('HA_CAMERA_CHANNELS_JSON');
  if (json === undefined) return {};
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('HA_CAMERA_CHANNELS_JSON must be a JSON object: {"1": "Front Door"}');
  }
  const channels = {};
  for (const [id, name] of Object.entries(json)) {
    const num = Number(id);
    if (!Number.isInteger(num) || num <= 0) {
      throw new Error(`HA_CAMERA_CHANNELS_JSON key "${id}" must be a positive integer channel number`);
    }
    channels[num] = String(name);
  }
  return channels;
}

export const CAMERA_CHANNELS = loadCameraChannels();
// Instance whose binary_sensor motion entities are reported by ha_get_camera_watches.
export const CAMERA_INSTANCE = env('HA_CAMERA_INSTANCE') || null;
