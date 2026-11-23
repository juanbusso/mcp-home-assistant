import fs from 'node:fs';
import path from 'node:path';
import { DISPLAY_LOCALE, DISPLAY_TIMEZONE, resolveInstance } from './config.mjs';
import { getCameraWatches as readCameraWatches, setCameraWatch } from './camera_watches.mjs';

export { resolveInstance, setCameraWatch };

function toLocalString(value) {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return undefined;
  return dt.toLocaleString(DISPLAY_LOCALE, { timeZone: DISPLAY_TIMEZONE, hour12: false });
}

export async function fetchHA(endpoint, options = {}, instance = null) {
  const conf = resolveInstance(instance);
  const baseUrl = conf.url.replace(/\/$/, '');
  const url = `${baseUrl}/api/${endpoint.replace(/^\//, '')}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(conf.token ? { Authorization: `Bearer ${conf.token}` } : {}),
    ...(options.headers || {})
  };

  const res = await fetch(url, {
    ...options,
    headers
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Home Assistant (${conf.name}) API error [${res.status} ${res.statusText}]: ${errorText}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return await res.json();
  }
  return await res.text();
}

export async function getStates(domain = null, entityId = null, instance = null) {
  if (entityId) {
    const state = await fetchHA(`states/${entityId}`, {}, instance);
    return state;
  }
  const allStates = await fetchHA('states', {}, instance);
  if (!domain) return allStates;
  return allStates.filter((s) => s.entity_id.startsWith(`${domain}.`));
}

export async function callService(domain, service, serviceData = {}, instance = null) {
  return await fetchHA(`services/${domain}/${service}`, {
    method: 'POST',
    body: JSON.stringify(serviceData)
  }, instance);
}

export async function getHistory(entityId, startTime = null, instance = null) {
  let endpoint = `history/period`;
  if (startTime) endpoint += `/${encodeURIComponent(startTime)}`;
  endpoint += `?filter_entity_id=${encodeURIComponent(entityId)}`;
  const rawHistory = await fetchHA(endpoint, {}, instance);
  
  if (Array.isArray(rawHistory)) {
    return rawHistory.map((period) => {
      if (!Array.isArray(period)) return period;
      return period.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const newItem = { ...item };
        if (item.last_changed) newItem.last_changed_local = toLocalString(item.last_changed);
        if (item.last_updated) newItem.last_updated_local = toLocalString(item.last_updated);
        return newItem;
      });
    });
  }
  return rawHistory;
}

export async function renderTemplate(template, instance = null) {
  return await fetchHA('template', {
    method: 'POST',
    body: JSON.stringify({ template })
  }, instance);
}

export async function downloadCameraSnapshot(entityId, outputPath = null, instance = null) {
  const conf = resolveInstance(instance);
  const baseUrl = conf.url.replace(/\/$/, '');
  const cleanEntityId = entityId.replace(/^\//, '');
  const url = `${baseUrl}/api/camera_proxy/${cleanEntityId}`;
  const headers = {
    ...(conf.token ? { Authorization: `Bearer ${conf.token}` } : {})
  };

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Home Assistant (${conf.name}) camera snapshot error [${res.status} ${res.statusText}]: ${errorText}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  let finalPath = outputPath;
  if (!finalPath) {
    const timestamp = Date.now();
    const sanitizedEntity = cleanEntityId.replace(/[^a-zA-Z0-9_-]/g, '_');
    finalPath = `/tmp/${sanitizedEntity}_${timestamp}.jpg`;
  }

  const dir = path.dirname(finalPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(finalPath, buffer);

  return {
    success: true,
    entity_id: cleanEntityId,
    instance: conf.name,
    file_path: finalPath,
    bytes: buffer.length,
    content_type: res.headers.get('content-type') || 'image/jpeg'
  };
}

export async function getCameraSnapshot(entityId, instance = null) {
  return await downloadCameraSnapshot(entityId, null, instance);
}

export async function sendHAWebSocketCommand(message, instance = null) {
  const conf = resolveInstance(instance);
  const wsUrl = conf.url.replace(/^http/, 'ws').replace(/\/$/, '') + '/api/websocket';

  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      return reject(new Error(`Failed to connect WebSocket to ${wsUrl}: ${e.message}`));
    }

    const messageId = 1;
    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { ws.close(); } catch {}
      reject(new Error(`WebSocket command timed out after 10000ms on ${conf.name}`));
    }, 10000);

    const cleanup = () => {
      finished = true;
      clearTimeout(timeout);
      try { ws.close(); } catch {}
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'auth_required') {
          ws.send(JSON.stringify({
            type: 'auth',
            access_token: conf.token
          }));
        } else if (data.type === 'auth_ok') {
          const payload = {
            id: messageId,
            ...message
          };
          ws.send(JSON.stringify(payload));
        } else if (data.type === 'auth_invalid') {
          cleanup();
          reject(new Error(`Home Assistant (${conf.name}) WebSocket auth failed: ${data.message || 'Invalid token'}`));
        } else if (data.type === 'result' && data.id === messageId) {
          cleanup();
          if (!data.success) {
            reject(new Error(data.error?.message || `WebSocket command error: ${JSON.stringify(data.error)}`));
          } else {
            resolve(data.result);
          }
        }
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    ws.onerror = (err) => {
      if (finished) return;
      cleanup();
      reject(new Error(`WebSocket connection error on ${conf.name}: ${err.message || err}`));
    };
  });
}

export async function updateEntityRegistry({ entityId, name, newEntityId, areaId, icon, instance = null }) {
  const payload = {
    type: 'config/entity_registry/update',
    entity_id: entityId
  };
  if (name !== undefined) payload.name = name;
  if (newEntityId !== undefined) payload.new_entity_id = newEntityId;
  if (areaId !== undefined) payload.area_id = areaId;
  if (icon !== undefined) payload.icon = icon;

  return await sendHAWebSocketCommand(payload, instance);
}

export async function getAreas(instance = null) {
  return await sendHAWebSocketCommand({ type: 'config/area_registry/list' }, instance);
}

export async function getCameraWatches() {
  return await readCameraWatches(getStates);
}
