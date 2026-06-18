# YoloBox Ultra REST-to-WebSocket Relay API

A lightweight Node.js middleware service that translates standard HTTP REST requests into WebSocket payloads required by the YoloBox Ultra, enabling automated scene switching, overlay management, and audio control over a local area network.

## Architecture

The service maintains two persistent outbound WebSocket connections to the YoloBox Ultra:

- **Command Socket** (`/remote/controller/postOrder`): Used strictly for transmitting control payloads to the device
- **Status Socket** (`/remote/controller/getDeviceStatus`): Streams the current device state (battery, bitrate, active scenes, etc.)

The Express REST API exposes these capabilities via standard HTTP endpoints, while automatic reconnection logic ensures resilience if the YoloBox goes offline.

## Prerequisites

- Node.js v18 or higher
- YoloBox Ultra with "Web Control" enabled
- Static IP address assigned to the YoloBox device
- Network connectivity from your development machine to the YoloBox

## Installation

1. **Clone or navigate to the project directory:**

```bash
cd YoloboxApi
```

2. **Install dependencies:**

```bash
npm install
```

3. **Create a `.env` file** from the provided template:

```bash
cp .env.example .env
```

4. **Edit `.env`** with your YoloBox configuration:

```ini
PORT=3000
YOLOBOX_IP=192.168.1.100
WS_PORT=8887
RECONNECT_INTERVAL=5000
```

## Running the Server

### Production Mode
```bash
npm start
```

### Development Mode (with file watching)
```bash
npm run dev
```

The server will start on the configured `PORT` (default: 3000) and immediately attempt to establish WebSocket connections to the YoloBox.

## API Documentation

Interactive Swagger documentation is available at:

```
http://localhost:3000/api/doc
```

### Endpoints

#### `GET /api/status`
Returns the most recently cached JSON payload from the Status Socket.

**Response (Success - 200):**
```json
{
  "success": true,
  "data": {
    "battery": 85,
    "bitrate": 5000,
    "activeScene": "Scene 1"
  }
}
```

**Response (Error - 503):**
```json
{
  "success": false,
  "error": "Status Socket not connected or no status cached yet"
}
```

#### `POST /api/command`
Sends a raw order payload to the YoloBox via the Command Socket (`/remote/controller/postOrder`). Use this for any order the device accepts (audio, overlays, go-live, tab switch). See the [WebSocket Protocol Reference](#websocket-protocol-reference) for payload shapes.

**Request Example (switch scene):**
```json
{
  "data": { "id": "38758", "isSelected": true },
  "orderID": "order_director_change"
}
```

**Response (Success - 200):**
```json
{
  "success": true,
  "message": "Command dispatched"
}
```

**Response (Error - 503):**
```json
{
  "success": false,
  "error": "Command Socket is not connected"
}
```

#### `GET /api/scenes`
Live-queries the device's `getDirectorList` and returns all scenes ("directors") with their IDs. The `id` is what you pass to `POST /api/scene`. `isSelected` marks the currently live scene.

**Response (Success - 200):**
```json
{
  "success": true,
  "scenes": [
    { "directorName": "Sony",   "id": "38758", "isSelected": true },
    { "directorName": "Obsbot", "id": "38759", "isSelected": false }
  ]
}
```

#### `POST /api/scene`
Convenience wrapper that switches the live scene by id (builds the `order_director_change` order for you). Get valid ids from `GET /api/scenes`.

**Request:**
```json
{ "id": "38758" }
```

**Response (Success - 200):**
```json
{
  "success": true,
  "message": "Scene switch dispatched (id=38758)"
}
```

#### `GET /api/scoreboard`
Live-queries the device's `getScoreboardInfo`. Returns the two teams (`teamName`, `score`), the current `period`, the match timer (`timeSetting`), whether the scoreboard overlay is shown (`showScoreboard`), and its `type`. Available on firmware that ships the local Web Control UI.

**Response (Success - 200):**
```json
{
  "success": true,
  "scoreboard": {
    "showScoreboard": true,
    "period": "First Half",
    "type": 0,
    "teams": [
      { "teamName": "Team 1", "score": 0 },
      { "teamName": "Team 2", "score": 0 }
    ],
    "timeSetting": { "isCountdown": false, "isPlaying": false, "seconds": 0, "showTime": false }
  }
}
```

#### `GET /api/health`
Returns the current connection status of both WebSocket sockets.

**Response (200):**
```json
{
  "success": true,
  "commandSocket": "OPEN",
  "statusSocket": "OPEN",
  "cachedStatusAvailable": true
}
```

## WebSocket Protocol Reference

This is the **verified** YoloBox Ultra Web Control protocol (firmware `Yolo-ultra-os-3.2.0`), reverse-engineered and confirmed live against a device. YoloLiv publishes no official spec; this documents what actually works.

> **Note on device generations.** The shipping Bitfocus module [`companion-module-yunxi-yolobox`](https://github.com/bitfocus/companion-module-yunxi-yolobox) targets a **newer** protocol on **port 8889** (`{property,value,group}` messages). The YoloBox Ultra documented here uses the **older `postOrder` protocol on port 8887**. Check which port your device exposes before assuming a format.

### Authentication — the `Origin` header (critical)

The YoloBox **rejects any WebSocket upgrade that has no `Origin` header**, closing immediately with code `4000 "Unauthorized"`. Browsers always send `Origin`; the Node `ws` client does **not** by default. The fix is simply to send one — the device does not validate its value:

```js
new WebSocket(url, { origin: `http://${YOLOBOX_IP}:8080` });
```

This relay sets it automatically (`WS_ORIGIN`, configurable via env). There is also a `/remote/controller/authenticate` endpoint, but per community testing it makes no difference — the `Origin` header alone is the gate.

### Transport

- **Host/port:** `ws://<YOLOBOX_IP>:8887`
- **Path = action:** the endpoint path *is* the command, e.g. `/remote/controller/getDirectorList`
- **Envelope:** responses are `{"code":200,"data":{...}}`. Read endpoints stream one JSON frame on connect.
- **Web Control UI.** Originally cloud-only at `http://web-control.yololiv.com/web-control`. Recent firmware also serves a **local** copy on the device at `http://<YOLOBOX_IP>:8081/web-control-detail.html` (phones are redirected to `/web-control-h5-detail.html`). Port 80 itself is still closed. The device serves 8080 (HTTP REST, e.g. `GET /remote/controller/getDeviceStatus`), 8081 (local Web Control UI), 8887 (WebSocket), and 9090 (proprietary). The local UI drives the box over the same `:8887` protocol documented here.

### Read endpoints (connect → receive one frame)

| Endpoint | Returns |
|---|---|
| `/remote/controller/getDeviceStatus` | Battery, CPU, memory, network, firmware, resolution, fps, temperature |
| `/remote/controller/getDirectorList` | **Scenes** ("directors") — `directorName`, `id`, `isSelected`, preview `url` |
| `/remote/controller/getMaterialList` | **Overlays** — `id` (`type=…&overlayId=…`), `isSelected`, preview `url` |
| `/remote/controller/getMixerList` | **Audio** channels — `id`, `mixerName`, `volume`, `AFV`, `isSelected` |
| `/remote/controller/getLiveStatus` | `living` (bool), `startTime` |
| `/remote/controller/getScoreboardInfo` | **Scoreboard** — `teams` (`teamName`, `score`), `period`, `timeSetting` (`isCountdown`, `isPlaying`, `seconds`, `showTime`), `showScoreboard`, `type` |
| `/remote/controller/heartbeat` | `{ "alive": true }` |

**`getDirectorList` example:**
```json
{
  "code": 200,
  "data": {
    "api": "/remote/controller/getDirectorList",
    "result": [
      { "directorName": "HDMI-1", "id": "2034491463", "isSelected": false },
      { "directorName": "Split View", "id": "629868886", "isSelected": true }
    ]
  }
}
```
Scenes are identified by their **`id` string** (an opaque, possibly negative integer — **not** a positional index). You must read the list to learn valid ids.

### Write commands — `/remote/controller/postOrder`

Send JSON of the form `{ "data": {...}, "orderID": "<order>" }`. The device replies on the same socket with `{"code":200,"data":{"result":{"message":"Success","resultCode":0}}}`.

| Order (`orderID`) | Effect | `data` payload |
|---|---|---|
| `order_director_change` | Switch live scene | `{ "id": "<directorId>", "isSelected": true }` |
| `order_material_change` | Enable/disable overlay | `{ "id": "type=lower_third&overlayId=11", "isSelected": false }` |
| `order_mixer_change` | Set audio channel | `{ "id": "Program", "isSelected": true, "volume": 0.7, "AFV": false }` |
| `order_live_status` | Go live / end live | `{ "status": "start" }` (or `"stop"`) |
| `order_tab_change` | Switch UI tab (cosmetic) | `{ "id": 4 }` |

**Switch scene (verified):**
```bash
curl -X POST http://localhost:3000/api/command \
  -H "Content-Type: application/json" \
  -d '{"data":{"id":"38758","isSelected":true},"orderID":"order_director_change"}'
```
Or use the convenience wrapper:
```bash
curl -X POST http://localhost:3000/api/scene -H "Content-Type: application/json" -d '{"id":"38758"}'
```

### Credits
Protocol details corroborated by the community reverse-engineering in [bitfocus/companion-module-yunxi-yolobox#1](https://github.com/bitfocus/companion-module-yunxi-yolobox/issues/1) and the open-source [Supergiovane/companion-to-yolobox](https://github.com/Supergiovane/companion-to-yolobox).

## Architecture Details

### WebSocket Connection Management

The service implements automatic reconnection with the following features:

- **Persistent Connections:** Both Command and Status sockets reconnect automatically if dropped
- **Configurable Reconnection Interval:** Set via `RECONNECT_INTERVAL` environment variable (default: 5000ms)
- **Graceful Degradation:** REST endpoints return appropriate HTTP status codes when sockets are unavailable
- **Status Caching:** The most recent Status Socket payload is cached in memory for immediate retrieval

### Error Handling

- **Command Socket Unavailable:** Returns HTTP 503 with a descriptive error message
- **Status Socket Unavailable:** Returns HTTP 503 with a descriptive error message
- **Invalid Payload:** Returns HTTP 400 with validation feedback
- **Connection Drops:** Logs the disconnection and schedules automatic reconnection

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | The port the Express API server will run on |
| `YOLOBOX_IP` | `192.168.1.100` | Static local IP address of the target YoloBox Ultra |
| `WS_PORT` | `8887` | The WebSocket port on the YoloBox |
| `WS_ORIGIN` | `http://<YOLOBOX_IP>:8080` | `Origin` header sent on every socket. Required — the device closes origin-less connections with `4000 Unauthorized`. The value is not validated; only its presence matters. |
| `RECONNECT_INTERVAL` | `5000` | Milliseconds between reconnection attempts |

## Troubleshooting

### Cannot connect to YoloBox
- Verify the `YOLOBOX_IP` and `WS_PORT` are correct in `.env`
- Ensure "Web Control" is enabled on the YoloBox device
- Confirm network connectivity: `ping <YOLOBOX_IP>`
- Check that port 8887 is not blocked by a firewall

### Status Socket never connects
- Verify the YoloBox is powered on and connected to the network
- Confirm "Web Control" is enabled in YoloBox settings
- Check the server logs for error messages

### Commands not being received by YoloBox
- Verify the Command Socket is in the `OPEN` state (check `/api/health`)
- If it connects then immediately drops with close code `4000 Unauthorized`, the `Origin` header is missing — see [Authentication](#authentication--the-origin-header-critical)
- Confirm the JSON payload matches the [WebSocket Protocol Reference](#websocket-protocol-reference) — wrong `orderID` or a positional index instead of the director `id` is silently ignored
- Use `GET /api/scenes` to get valid scene ids

## Logs

The service logs all WebSocket events and command dispatches to stdout:

```
[Command Socket] Connected
[Status Socket] Connected
[Command Socket] Sent payload: { id: 1, action: 'switchScene', ... }
[Status Socket] Received status update
```

## License

ISC
