# mcp-home-assistant

A dependency-free [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for
[Home Assistant](https://www.home-assistant.io/). It talks to one **or several** Home Assistant
instances over the REST and WebSocket APIs and exposes them as MCP tools over stdio.

- Zero npm dependencies (uses Node's built-in `fetch` and `WebSocket`)
- Multiple instances, with optional aliases, from a single JSON env var
- Optional per-process instance lock (`--instance=<name>`) for least-privilege setups

## Requirements

- Node.js **22+** (for the global `WebSocket`)
- A Home Assistant [long-lived access token](https://developers.home-assistant.io/docs/auth_api/#long-lived-access-token)
  (Profile → Security → Long-lived access tokens)

## Configuration

Configuration is read from environment variables. A `.env` file in the project root is also
loaded (real environment variables take precedence). See [`.env.example`](.env.example).

### Single instance

```bash
HA_URL=http://homeassistant.local:8123
HA_TOKEN=your_long_lived_access_token
```

The instance is exposed under the name `default`.

### Multiple instances

```bash
HA_INSTANCES_JSON='{"home":{"url":"http://homeassistant.local:8123","token":"..."},"office":{"url":"https://ha.example.com","token":"...","aliases":["work"]}}'
HA_DEFAULT_INSTANCE=home   # optional, defaults to the first key
```

`HA_INSTANCES_JSON` takes precedence over `HA_URL` / `HA_TOKEN`. Every tool accepts an optional
`instance` argument (an instance name or alias); its JSON schema `enum` is generated from your config.

### Locking a server to one instance

Run with `--instance=<name>` (or `HA_LOCKED_INSTANCE=<name>`). Calls targeting any other
instance are rejected. Useful when you register one MCP server per instance.

### All variables

| Variable | Required | Description |
| --- | --- | --- |
| `HA_URL` / `HA_TOKEN` | one of these two options | Single-instance URL and token |
| `HA_INSTANCES_JSON` | one of these two options | JSON map `{ name: { url, token, aliases? } }` |
| `HA_DEFAULT_INSTANCE` | no | Instance used when a call omits `instance` |
| `HA_LOCKED_INSTANCE` | no | Restrict the process to a single instance |
| `HA_LOCALE` / `HA_TIMEZONE` | no | Locale/IANA timezone for `*_local` timestamps in history results (defaults to system) |
| `HA_CAMERA_WATCHES_PATH` | no | JSON file written by `ha_watch_camera` (default `./data/camera_watches.json`, `~` expanded) |
| `HA_CAMERA_CHANNELS_JSON` | no | NVR channel → name map, e.g. `{"1":"Front Door","2":"Backyard"}` |
| `HA_CAMERA_INSTANCE` | no | Instance whose motion sensors `ha_get_camera_watches` lists (defaults to the default instance) |

## Tools

| Tool | Description |
| --- | --- |
| `ha_get_states` | Entity states, optionally filtered by `domain` or `entity_id` |
| `ha_call_service` | Call any service (`light.turn_on`, `cover.open_cover`, …) |
| `ha_get_history` | State history for an entity |
| `ha_render_template` | Render a Jinja2 template |
| `ha_get_camera_image` | Save a camera snapshot to a local file |
| `ha_update_entity` | Rename / re-area / re-icon an entity in the entity registry |
| `ha_get_areas` | List areas |
| `ha_ws_command` | Send an arbitrary WebSocket API command |
| `ha_watch_camera` | Add/remove/clear motion "watches" in a local JSON file |
| `ha_get_camera_watches` | Active watches plus live state of all `device_class: motion` binary sensors |

### About camera watches

`ha_watch_camera` does **not** send notifications by itself. It maintains a JSON file
(`HA_CAMERA_WATCHES_PATH`) with entries like:

```json
{ "watches": [ { "id": "watch_2_…", "channel": 2, "camera_name": "Backyard", "enabled": true,
  "expires_at": "…", "cooldown_seconds": 30, "max_alerts": null, "notify_count": 0 } ] }
```

A separate process of your own (an automation, a notifier bot, etc.) can read this file and push
snapshots when motion is detected. Cameras can be referenced by channel number or by the names in
`HA_CAMERA_CHANNELS_JSON`.

## Usage with an MCP client

See [`mcp_config.json`](mcp_config.json) for a template. Example:

```json
{
  "mcpServers": {
    "home-assistant": {
      "command": "node",
      "args": ["--no-warnings", "/ABSOLUTE/PATH/TO/mcp-home-assistant/src/mcp_server.mjs"],
      "env": {
        "HA_URL": "http://homeassistant.local:8123",
        "HA_TOKEN": "YOUR_LONG_LIVED_ACCESS_TOKEN"
      }
    }
  }
}
```

## Development

```bash
npm run check   # node --check on every source file
npm start       # start the stdio server
```

## Security notes

- Never commit `.env` or a filled-in `mcp_config.json` — tokens grant full control of your Home Assistant.
- `ha_call_service` and `ha_ws_command` can change anything the token can; consider a dedicated
  Home Assistant user and the instance lock for agents you don't fully trust.
