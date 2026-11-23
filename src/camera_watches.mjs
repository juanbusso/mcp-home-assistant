import fs from 'node:fs';
import path from 'node:path';
import { CAMERA_CHANNELS, CAMERA_INSTANCE, CAMERA_WATCHES_PATH } from './config.mjs';

function stripAccents(s) {
  return String(s).toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function channelName(id) {
  return CAMERA_CHANNELS[id] || `Camera ${id}`;
}

function normalizeCamera(input) {
  if (!input) return { id: null, name: null };
  const clean = stripAccents(input);
  if (clean === 'all') {
    return { id: 'all', name: 'All cameras' };
  }
  // A bare channel number (or camera_NN) is always accepted, even without HA_CAMERA_CHANNELS_JSON.
  const numMatch = clean.match(/^(?:camera_|camara_)?0*(\d+)$/);
  if (numMatch) {
    const id = Number(numMatch[1]);
    if (id > 0) return { id, name: channelName(id) };
  }
  for (const [idStr, name] of Object.entries(CAMERA_CHANNELS)) {
    const nameClean = stripAccents(name);
    if (nameClean.includes(clean) || clean.includes(nameClean)) {
      return { id: Number(idStr), name };
    }
  }
  return { id: null, name: null };
}

function readWatches() {
  if (!fs.existsSync(CAMERA_WATCHES_PATH)) return { watches: [] };
  const raw = fs.readFileSync(CAMERA_WATCHES_PATH, 'utf-8');
  try {
    const data = JSON.parse(raw);
    return { ...data, watches: Array.isArray(data.watches) ? data.watches : [] };
  } catch (err) {
    throw new Error(`Camera watches file ${CAMERA_WATCHES_PATH} is not valid JSON: ${err.message}`);
  }
}

function writeWatches(data) {
  fs.mkdirSync(path.dirname(CAMERA_WATCHES_PATH), { recursive: true });
  fs.writeFileSync(CAMERA_WATCHES_PATH, JSON.stringify(data, null, 2));
}

export async function setCameraWatch({ camera, action = 'add', duration_minutes = 30, cooldown_seconds = 30, max_alerts = null }) {
  const data = readWatches();
  const { id: channelId, name: cameraName } = normalizeCamera(camera);

  if (action === 'clear') {
    data.watches = [];
    writeWatches(data);
    return { success: true, message: 'All camera watches were removed.' };
  }

  if (action === 'remove' || action === 'disable') {
    const before = data.watches.length;
    data.watches = data.watches.filter(w =>
      w.channel !== channelId &&
      w.camera_name?.toLowerCase() !== camera?.toLowerCase() &&
      w.id !== camera
    );
    writeWatches(data);
    return { success: true, message: `Watch for "${camera}" removed (${before - data.watches.length} deleted).` };
  }

  if (!channelId) {
    const known = Object.values(CAMERA_CHANNELS);
    throw new Error(
      `Unknown camera: "${camera}". Use a channel number${known.length ? `, one of: ${known.join(', ')}` : ''}, or "all".`
    );
  }

  const now = new Date();
  let expiresAt = null;
  if (duration_minutes && duration_minutes > 0) {
    expiresAt = new Date(now.getTime() + duration_minutes * 60000).toISOString();
  }

  const newWatch = {
    id: `watch_${channelId}_${Date.now()}`,
    channel: channelId,
    camera_name: cameraName,
    enabled: true,
    created_at: now.toISOString(),
    expires_at: expiresAt,
    cooldown_seconds: cooldown_seconds || 30,
    max_alerts: max_alerts || null,
    notify_count: 0,
    last_notified: null
  };

  data.watches = data.watches.filter(w => w.channel !== channelId);
  data.watches.push(newWatch);
  writeWatches(data);

  return {
    success: true,
    message: `Camera watch enabled for ${cameraName} (channel ${channelId}).`,
    watch: newWatch
  };
}

export async function getCameraWatches(getStates) {
  const { watches } = readWatches();

  try {
    const allStates = await getStates('binary_sensor', null, CAMERA_INSTANCE);
    const sensors = allStates
      .filter(s => s.attributes?.device_class === 'motion')
      .map(s => ({
        entity_id: s.entity_id,
        friendly_name: s.attributes?.friendly_name,
        state: s.state,
        last_motion: s.attributes?.last_motion_at || null
      }));
    return { watches_file: CAMERA_WATCHES_PATH, active_watches: watches, motion_sensors: sensors };
  } catch (err) {
    return {
      watches_file: CAMERA_WATCHES_PATH,
      active_watches: watches,
      motion_sensors: [],
      motion_sensors_error: err.message
    };
  }
}
