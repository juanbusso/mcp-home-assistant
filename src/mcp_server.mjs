import readline from 'node:readline';
import {
  callService,
  downloadCameraSnapshot,
  getAreas,
  getCameraWatches,
  getHistory,
  getStates,
  renderTemplate,
  sendHAWebSocketCommand,
  setCameraWatch,
  updateEntityRegistry
} from './client.mjs';
import { DEFAULT_INSTANCE, INSTANCE_NAMES, resolveInstance } from './config.mjs';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function sendResponse(id, result, error = null) {
  const response = {
    jsonrpc: '2.0',
    id
  };
  if (error) {
    response.error = error;
  } else {
    response.result = result;
  }
  process.stdout.write(JSON.stringify(response) + '\n');
}

const INSTANCE_PROPERTY = {
  type: 'string',
  ...(INSTANCE_NAMES.length ? { enum: INSTANCE_NAMES } : {}),
  description: `Optional: Home Assistant instance name${
    INSTANCE_NAMES.length ? ` (configured: ${INSTANCE_NAMES.join(', ')}; default: ${DEFAULT_INSTANCE})` : ''
  }.`
};

const TOOLS = [
  {
    name: 'ha_get_states',
    description:
      'Gets the state of Home Assistant entities (lights, temperature sensors, gates, cameras, presence, alarms, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        instance: INSTANCE_PROPERTY,
        domain: {
          type: 'string',
          description: 'Optional: filter by domain (e.g. "switch", "light", "sensor", "binary_sensor", "camera", "cover", "lock").'
        },
        entity_id: {
          type: 'string',
          description: 'Optional: a specific entity ID (e.g. "switch.hallway_light", "cover.garage_door").'
        }
      }
    }
  },
  {
    name: 'ha_call_service',
    description:
      'Calls a Home Assistant service/action (turn lights on/off, open/close covers, trigger automations, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        instance: INSTANCE_PROPERTY,
        domain: {
          type: 'string',
          description: 'Service domain (e.g. "light", "switch", "cover", "homeassistant", "automation", "script")'
        },
        service: {
          type: 'string',
          description: 'Service name (e.g. "turn_on", "turn_off", "toggle", "open_cover", "close_cover", "trigger")'
        },
        service_data: {
          type: 'object',
          description: 'Service data (e.g. {"entity_id": "switch.kitchen_light"})'
        }
      },
      required: ['domain', 'service']
    }
  },
  {
    name: 'ha_get_history',
    description: 'Gets the state history of an entity over a period of time.',
    inputSchema: {
      type: 'object',
      properties: {
        instance: INSTANCE_PROPERTY,
        entity_id: {
          type: 'string',
          description: 'Entity ID (e.g. "sensor.living_room_temperature")'
        },
        start_time: {
          type: 'string',
          description: 'Optional: start date/time in ISO format (e.g. "2026-08-31T18:00:00Z")'
        }
      },
      required: ['entity_id']
    }
  },
  {
    name: 'ha_render_template',
    description: 'Renders a Jinja2 template in Home Assistant for advanced state queries and calculations.',
    inputSchema: {
      type: 'object',
      properties: {
        instance: INSTANCE_PROPERTY,
        template: {
          type: 'string',
          description: 'Jinja2 template to render (e.g. "{{ states.switch | selectattr(\'state\', \'eq\', \'on\') | list | length }}")'
        }
      },
      required: ['template']
    }
  },
  {
    name: 'ha_get_camera_image',
    description:
      'Downloads the current snapshot of a Home Assistant camera and saves it to a local file.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: {
          type: 'string',
          description: 'Camera entity ID (e.g. "camera.front_door").'
        },
        instance: INSTANCE_PROPERTY,
        output_path: {
          type: 'string',
          description: 'Optional: absolute local file path to save the image to (e.g. "/tmp/front_door.jpg").'
        }
      },
      required: ['entity_id']
    }
  },
  {
    name: 'ha_update_entity',
    description:
      'Updates the name, area or icon of an entity in the Home Assistant entity registry (config/entity_registry/update).',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: {
          type: 'string',
          description: 'Current entity ID (e.g. "camera.camera_01", "light.kitchen").'
        },
        instance: INSTANCE_PROPERTY,
        name: {
          type: 'string',
          description: 'Optional: new friendly name for the entity (e.g. "Front Door Camera").'
        },
        new_entity_id: {
          type: 'string',
          description: 'Optional: new entity_id to rename the identifier (e.g. "camera.front_door").'
        },
        area_id: {
          type: 'string',
          description: 'Optional: area ID to assign the entity to (e.g. "living_room", "kitchen").'
        },
        icon: {
          type: 'string',
          description: 'Optional: Material Design icon (e.g. "mdi:camera", "mdi:television").'
        }
      },
      required: ['entity_id']
    }
  },
  {
    name: 'ha_get_areas',
    description: 'Lists all areas/rooms configured in Home Assistant (config/area_registry/list).',
    inputSchema: {
      type: 'object',
      properties: {
        instance: INSTANCE_PROPERTY
      }
    }
  },
  {
    name: 'ha_ws_command',
    description:
      'Runs an arbitrary command on the Home Assistant WebSocket API (e.g. config/device_registry/list, config/entity_registry/list).',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'WebSocket command type (e.g. "config/area_registry/list", "config/entity_registry/list", "config/device_registry/list").'
        },
        data: {
          type: 'object',
          description: 'Optional: additional fields for the command.'
        },
        instance: INSTANCE_PROPERTY
      },
      required: ['type']
    }
  },
  {
    name: 'ha_watch_camera',
    description:
      'Adds or removes a motion "watch" on one or more NVR camera channels. Watches are written to a local JSON file (HA_CAMERA_WATCHES_PATH) that an external notifier process can consume to send snapshots when motion is detected.',
    inputSchema: {
      type: 'object',
      properties: {
        camera: {
          type: 'string',
          description:
            'Camera name (as configured in HA_CAMERA_CHANNELS_JSON), channel number (e.g. "1"), or "all" to watch every camera.'
        },
        action: {
          type: 'string',
          enum: ['add', 'remove', 'clear'],
          description: '"add" to enable the watch (default), "remove" to disable it, "clear" to remove all watches.'
        },
        duration_minutes: {
          type: 'number',
          description: 'Watch duration in minutes (e.g. 30, 60). Optional, defaults to 30.'
        },
        cooldown_seconds: {
          type: 'number',
          description: 'Minimum seconds between alerts to avoid flooding notifications (default 30).'
        },
        max_alerts: {
          type: 'number',
          description: 'Optional: maximum number of alerts to send before the watch ends.'
        }
      },
      required: ['camera']
    }
  },
  {
    name: 'ha_get_camera_watches',
    description:
      'Lists the currently active camera watches and the live state of all motion binary sensors in Home Assistant.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];

const instanceArg = process.argv.find((a) => a.startsWith('--instance='));
const LOCKED_INSTANCE_INPUT = instanceArg ? instanceArg.split('=')[1] : process.env.HA_LOCKED_INSTANCE || null;
// Resolve once at startup so aliases are canonicalized and typos fail loudly.
const LOCKED_INSTANCE = LOCKED_INSTANCE_INPUT ? resolveInstance(LOCKED_INSTANCE_INPUT).name : null;

async function handleToolCall(name, args = {}) {
  let instance = args.instance || null;
  if (LOCKED_INSTANCE) {
    if (args.instance && resolveInstance(args.instance).name !== LOCKED_INSTANCE) {
      throw new Error(
        `Access denied: this MCP server is restricted to instance "${LOCKED_INSTANCE}". Interacting with "${args.instance}" is not allowed.`
      );
    }
    instance = LOCKED_INSTANCE;
  }
  switch (name) {
    case 'ha_get_states': {
      return await getStates(args.domain || null, args.entity_id || null, instance);
    }
    case 'ha_call_service': {
      return await callService(args.domain, args.service, args.service_data || {}, instance);
    }
    case 'ha_get_history': {
      return await getHistory(args.entity_id, args.start_time || null, instance);
    }
    case 'ha_render_template': {
      const result = await renderTemplate(args.template, instance);
      return { result };
    }
    case 'ha_get_camera_image':
    case 'ha_get_camera_snapshot': {
      return await downloadCameraSnapshot(args.entity_id, args.output_path || null, instance);
    }
    case 'ha_update_entity': {
      return await updateEntityRegistry({
        entityId: args.entity_id,
        name: args.name,
        newEntityId: args.new_entity_id,
        areaId: args.area_id,
        icon: args.icon,
        instance
      });
    }
    case 'ha_get_areas': {
      return await getAreas(instance);
    }
    case 'ha_ws_command': {
      const payload = {
        type: args.type,
        ...(args.data || {})
      };
      return await sendHAWebSocketCommand(payload, instance);
    }
    case 'ha_watch_camera': {
      return await setCameraWatch({
        camera: args.camera,
        action: args.action || 'add',
        duration_minutes: args.duration_minutes !== undefined ? args.duration_minutes : 30,
        cooldown_seconds: args.cooldown_seconds || 30,
        max_alerts: args.max_alerts || null
      });
    }
    case 'ha_get_camera_watches': {
      return await getCameraWatches();
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

rl.on('line', async (line) => {
  if (!line.trim()) return;

  try {
    const request = JSON.parse(line);
    const { id, method, params } = request;

    if (method === 'initialize') {
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: LOCKED_INSTANCE ? `ha-${LOCKED_INSTANCE}` : 'home-assistant-mcp',
          version: '1.3.0'
        }
      });
    } else if (method === 'notifications/initialized') {
      // No response needed
    } else if (method === 'ping') {
      sendResponse(id, {});
    } else if (method === 'tools/list') {
      const toolsToReturn = LOCKED_INSTANCE
        ? TOOLS.map((t) => {
            const copy = JSON.parse(JSON.stringify(t));
            copy.description = `${t.description} [Instance: ${LOCKED_INSTANCE}]`;
            if (copy.inputSchema?.properties?.instance) {
              copy.inputSchema.properties.instance.description = `Fixed instance for this server: "${LOCKED_INSTANCE}". Optional (enforced automatically).`;
              copy.inputSchema.properties.instance.enum = [LOCKED_INSTANCE];
              copy.inputSchema.properties.instance.default = LOCKED_INSTANCE;
            }
            return copy;
          })
        : TOOLS;
      sendResponse(id, {
        tools: toolsToReturn
      });
    } else if (method === 'tools/call') {
      try {
        const resultData = await handleToolCall(params.name, params.arguments || {});
        sendResponse(id, {
          content: [
            {
              type: 'text',
              text: typeof resultData === 'string' ? resultData : JSON.stringify(resultData, null, 2)
            }
          ]
        });
      } catch (callErr) {
        sendResponse(id, {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error running ${params.name}: ${callErr.message}`
            }
          ]
        });
      }
    } else {
      sendResponse(id, null, {
        code: -32601,
        message: `Method not found: ${method}`
      });
    }
  } catch (err) {
    console.error('Error processing JSON-RPC:', err);
  }
});
