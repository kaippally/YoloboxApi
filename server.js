import express from 'express';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const YOLOBOX_IP = process.env.YOLOBOX_IP || '192.168.1.100';
const WS_PORT = process.env.WS_PORT || 8887;
const RECONNECT_INTERVAL = parseInt(process.env.RECONNECT_INTERVAL || '5000', 10);
// YoloBox rejects origin-less WebSocket upgrades with close code 4000 "Unauthorized".
// Sending any Origin header satisfies the gate; default to the device's own HTTP origin.
const WS_ORIGIN = process.env.WS_ORIGIN || `http://${YOLOBOX_IP}:8080`;

// ============================================================================
// WebSocket Connection Management
// ============================================================================

let authSocket = null;
let commandSocket = null;
let statusSocket = null;
let cachedStatus = null;
let authenticated = false;
let authReconnectTimer = null;
let authRefreshTimer = null;
let commandReconnectTimer = null;
let statusReconnectTimer = null;
let lastSocketError = null;

// The device expires a freshly-authenticated session after ~10-15s and a
// ws-level ping does NOT refresh it — only opening a new authenticate socket
// does. We re-authenticate well inside that window, make-before-break, so there
// is always a live authorized session.
const AUTH_REFRESH_MS = 8000;

/**
 * Open an authenticate socket (/remote/controller/authenticate). This firmware
 * serves every other endpoint only while an authenticate session is live AND
 * recent — without it each read/command socket is closed with 4000
 * "Unauthorized" (the Origin header alone is NOT sufficient on Yolo-ultra-os).
 *
 * Authorization lapses ~10-15s after each authenticate, so we call this on a
 * timer (AUTH_REFRESH_MS) and keep the previous socket open until the new one
 * is live (make-before-break) to avoid an unauthorized gap.
 */
function connectAuthSocket() {
  if (authReconnectTimer) {
    clearTimeout(authReconnectTimer);
    authReconnectTimer = null;
  }
  const url = `ws://${YOLOBOX_IP}:${WS_PORT}/remote/controller/authenticate`;
  const next = new WebSocket(url, { origin: WS_ORIGIN });
  let opened = false;

  next.on('open', () => {
    opened = true;
    const wasAuthenticated = authenticated;
    const prev = authSocket;
    authSocket = next;
    authenticated = true;
    // Drop the superseded session only once the new one is up (make-before-break).
    if (prev && prev !== next) {
      prev._superseded = true;
      setTimeout(() => { try { prev.close(); } catch { /* ignore */ } }, 1000);
    }
    if (!authRefreshTimer) authRefreshTimer = setInterval(connectAuthSocket, AUTH_REFRESH_MS);
    if (!wasAuthenticated) {
      console.log('[Auth Socket] Session authorized');
      connectCommandSocket();
      connectStatusSocket();
    }
  });

  next.on('error', (error) => {
    console.error('[Auth Socket] Error:', error.message);
  });

  next.on('close', (code, reason) => {
    // A socket we deliberately replaced make-before-break — its close is expected.
    if (next._superseded) return;

    if (next === authSocket) {
      // The live session dropped — tear down and reconnect.
      authenticated = false;
      authSocket = null;
      if (authRefreshTimer) {
        clearInterval(authRefreshTimer);
        authRefreshTimer = null;
      }
      console.log(`[Auth Socket] Live session dropped (code ${code}${reason?.length ? ` ${reason}` : ''}). Reconnecting...`);
      scheduleAuthReconnect();
    } else if (!opened && !authenticated) {
      // A reconnect attempt that never opened (device unreachable). Must keep
      // retrying — otherwise the reconnect chain dies after a single failure
      // and the relay stays stuck unauthorized until a full process restart.
      console.log(`[Auth Socket] Reconnect attempt failed (code ${code}). Retrying...`);
      scheduleAuthReconnect();
    }
  });
}

function scheduleAuthReconnect() {
  if (authReconnectTimer) return;
  authReconnectTimer = setTimeout(() => {
    authReconnectTimer = null;
    connectAuthSocket();
  }, RECONNECT_INTERVAL);
}

/**
 * Connect to the Command Socket (/remote/controller/postOrder).
 * This socket is used strictly for transmitting control payloads.
 */
function connectCommandSocket() {
  if (commandSocket && commandSocket.readyState === WebSocket.OPEN) {
    return;
  }

  const url = `ws://${YOLOBOX_IP}:${WS_PORT}/remote/controller/postOrder`;
  console.log(`[Command Socket] Attempting to connect to ${url}`);

  commandSocket = new WebSocket(url, { origin: WS_ORIGIN });

  commandSocket.on('open', () => {
    console.log('[Command Socket] Connected');
    if (commandReconnectTimer) {
      clearTimeout(commandReconnectTimer);
      commandReconnectTimer = null;
    }
  });

  commandSocket.on('error', (error) => {
    lastSocketError = error.message;
    console.error('[Command Socket] Error:', error.message);
  });

  commandSocket.on('close', () => {
    console.log('[Command Socket] Disconnected. Will attempt to reconnect...');
    scheduleCommandReconnect();
  });
}

/**
 * Schedule a reconnection attempt for the Command Socket.
 */
function scheduleCommandReconnect() {
  if (commandReconnectTimer) return;
  commandReconnectTimer = setTimeout(() => {
    commandReconnectTimer = null;
    connectCommandSocket();
  }, RECONNECT_INTERVAL);
}

/**
 * Connect to the Status Socket (/remote/controller/getDeviceStatus).
 * This socket receives the current device state.
 */
function connectStatusSocket() {
  if (statusSocket && statusSocket.readyState === WebSocket.OPEN) {
    return;
  }

  const url = `ws://${YOLOBOX_IP}:${WS_PORT}/remote/controller/getDeviceStatus`;
  console.log(`[Status Socket] Attempting to connect to ${url}`);

  statusSocket = new WebSocket(url, { origin: WS_ORIGIN });

  statusSocket.on('open', () => {
    console.log('[Status Socket] Connected');
    if (statusReconnectTimer) {
      clearTimeout(statusReconnectTimer);
      statusReconnectTimer = null;
    }
  });

  statusSocket.on('message', (data) => {
    try {
      cachedStatus = JSON.parse(data);
      console.log('[Status Socket] Received status update');
    } catch (error) {
      console.error('[Status Socket] Failed to parse status message:', error.message);
    }
  });

  statusSocket.on('error', (error) => {
    lastSocketError = error.message;
    console.error('[Status Socket] Error:', error.message);
  });

  statusSocket.on('close', () => {
    console.log('[Status Socket] Disconnected. Will attempt to reconnect...');
    scheduleStatusReconnect();
  });
}

/**
 * Schedule a reconnection attempt for the Status Socket.
 */
function scheduleStatusReconnect() {
  if (statusReconnectTimer) return;
  statusReconnectTimer = setTimeout(() => {
    statusReconnectTimer = null;
    connectStatusSocket();
  }, RECONNECT_INTERVAL);
}

/**
 * One-shot query of a read endpoint that streams a single JSON frame on connect
 * (getDirectorList, getMixerList, getMaterialList, …). Resolves with data.result.
 * Uses its own short-lived socket so it never contends with the persistent ones.
 * Transient failures (4000 de-auth race, connect timeout, early close) are tagged
 * `err.transient = true` so queryEndpoint can retry them.
 */
function queryEndpointOnce(endpoint, connectTimeoutMs = 6000, frameTimeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const transient = (msg) => Object.assign(new Error(msg), { transient: true });
    if (!authenticated) {
      return reject(transient('Not authorized — the authenticate session is not live yet.'));
    }
    const url = `ws://${YOLOBOX_IP}:${WS_PORT}/remote/controller/${endpoint}`;
    const ws = new WebSocket(url, { origin: WS_ORIGIN });
    let settled = false;
    let opened = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(connectTimer); clearTimeout(frameTimer); try { ws.close(); } catch {} ; fn(v); };

    const connectTimer = setTimeout(() => finish(reject, transient(
      `Could not connect to ${url} within ${connectTimeoutMs}ms.`
    )), connectTimeoutMs);
    let frameTimer = null;

    ws.on('open', () => {
      opened = true;
      clearTimeout(connectTimer);
      frameTimer = setTimeout(() => finish(reject, transient(
        `Connected to ${endpoint} but no JSON frame arrived within ${frameTimeoutMs}ms.`
      )), frameTimeoutMs);
    });
    ws.on('message', (raw) => {
      try {
        const json = JSON.parse(raw.toString());
        if (json && json.data) finish(resolve, json.data.result ?? json.data);
      } catch { /* wait for a parseable frame */ }
    });
    ws.on('error', (e) => finish(reject, Object.assign(e, { transient: true })));
    ws.on('close', (code, reason) => {
      if (code === 4000) {
        finish(reject, transient(`Device de-authorized the query socket (4000 ${reason?.toString() || 'Unauthorized'}).`));
      } else {
        finish(reject, transient(`Socket ${opened ? 'closed before a frame arrived' : 'closed during connect'} (code ${code}${reason?.length ? ` ${reason}` : ''})`));
      }
    });
  });
}

/**
 * Query a read endpoint with bounded retry. This firmware authorizes each new
 * socket at open time, and there are brief windows around the make-before-break
 * auth refresh where a freshly-opened query socket is rejected with 4000 even
 * though the persistent command/status sockets stay authorized. Rather than
 * surfacing that race to the caller, we kick a fresh authenticate and retry a
 * few times — the query succeeds on the next attempt once auth re-settles.
 */
async function queryEndpoint(endpoint, retries = 3, retryDelayMs = 350) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await queryEndpointOnce(endpoint);
    } catch (err) {
      lastErr = err;
      if (!err.transient || attempt === retries) break;
      connectAuthSocket(); // re-establish the auth session immediately
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Cached read-query wrapper. The polled read endpoints (scenes, overlays, audio,
// live) are hit every few seconds by every connected client, and each call opens a
// fresh short-lived query socket on finicky firmware that intermittently 4000s
// ("de-authorized"). This wrapper:
//   • coalesces concurrent callers for the same endpoint into ONE device query
//     (in-flight dedupe), so N simultaneous clients = 1 socket, not N;
//   • caches the last result for QUERY_CACHE_TTL_MS so rapid polls don't each hit
//     the device;
//   • on a transient query failure, returns the LAST-GOOD value instead of
//     throwing — so a momentary de-auth never empties the caller's list. It only
//     throws if there is no cached value at all.
const QUERY_CACHE_TTL_MS = parseInt(process.env.QUERY_CACHE_TTL_MS || '2000', 10);
const _queryCache = new Map();   // endpoint -> { value, ts }
const _queryInFlight = new Map(); // endpoint -> Promise
// Returns { data, stale }: stale=true when the live query failed and we fell back to the
// last-good value (a de-auth blip). Fresh successes and within-TTL hits are stale=false.
async function cachedQuery(endpoint) {
  const cached = _queryCache.get(endpoint);
  if (cached && Date.now() - cached.ts < QUERY_CACHE_TTL_MS) return { data: cached.value, stale: false };
  if (_queryInFlight.has(endpoint)) return _queryInFlight.get(endpoint);
  const p = (async () => {
    try {
      const value = await queryEndpoint(endpoint);
      _queryCache.set(endpoint, { value, ts: Date.now() });
      return { data: value, stale: false };
    } catch (err) {
      const prev = _queryCache.get(endpoint);
      if (prev) {
        console.log(`[Query Cache] ${endpoint} failed (${err.message}); serving last-good (${Math.round((Date.now() - prev.ts) / 1000)}s old).`);
        return { data: prev.value, stale: true };
      }
      throw err;
    } finally {
      _queryInFlight.delete(endpoint);
    }
  })();
  _queryInFlight.set(endpoint, p);
  return p;
}

// ============================================================================
// Express Middleware
// ============================================================================

app.use(express.json());

// ============================================================================
// Swagger Documentation Setup
// ============================================================================

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'YoloBox Ultra REST-to-WebSocket Relay API',
      version: '1.0.0',
      description: 'A middleware service that translates HTTP REST requests into WebSocket payloads for YoloBox Ultra control',
    },
    servers: [
      {
        url: `http://localhost:${PORT}`,
        description: 'Development server',
      },
    ],
  },
  apis: ['./server.js'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api/doc', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ============================================================================
// REST API Routes
// ============================================================================

/**
 * @swagger
 * /api/scenes:
 *   get:
 *     summary: List the YoloBox scenes (directors) with their IDs
 *     description: Live-queries the device's getDirectorList endpoint. Each scene's `id` is what you pass to POST /api/scene to switch to it. `isSelected` marks the currently live scene.
 *     responses:
 *       200:
 *         description: Scene list retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 scenes:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       directorName: { type: string, example: "Sony" }
 *                       id: { type: string, example: "38758" }
 *                       isSelected: { type: boolean, example: true }
 *       503:
 *         description: Could not reach the device
 */
app.get('/api/scenes', async (_req, res) => {
  try {
    const { data: scenes, stale } = await cachedQuery('getDirectorList');
    res.json({ success: true, scenes, stale });
  } catch (error) {
    res.status(503).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/scene:
 *   post:
 *     summary: Switch the live scene by id
 *     description: Sends an order_director_change command to the YoloBox. Get valid ids from GET /api/scenes.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id]
 *             properties:
 *               id:
 *                 type: string
 *                 description: The director id from GET /api/scenes
 *                 example: "38758"
 *     responses:
 *       200:
 *         description: Switch command dispatched
 *       400:
 *         description: Missing id
 *       503:
 *         description: Command Socket is not connected
 */
app.post('/api/scene', (req, res) => {
  const id = req.body?.id;
  if (id === undefined || id === null || id === '') {
    return res.status(400).json({ success: false, error: 'Body must include an "id" (get it from GET /api/scenes)' });
  }
  if (!commandSocket || commandSocket.readyState !== WebSocket.OPEN) {
    return res.status(503).json({ success: false, error: 'Command Socket is not connected' });
  }
  const order = { data: { id: String(id), isSelected: true }, orderID: 'order_director_change' };
  commandSocket.send(JSON.stringify(order));
  _queryCache.delete('getDirectorList'); // state changed — next read must be fresh
  // Single chokepoint for scene switches — fires for both the Yolobox tab and the timeline.
  console.log(`[YOLO→DEVICE] scene change → id=${id}`);
  res.json({ success: true, message: `Scene switch dispatched (id=${id})` });
});

/**
 * @swagger
 * /api/overlays:
 *   get:
 *     summary: List the YoloBox overlays (materials) with their IDs
 *     description: Live-queries the device's getMaterialList endpoint. Each overlay's `id` (e.g. "type=lower_third&overlayId=11") is what you pass to POST /api/overlay to toggle it. `isSelected` marks overlays currently shown.
 *     responses:
 *       200:
 *         description: Overlay list retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 overlays:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, example: "type=lower_third&overlayId=11" }
 *                       isSelected: { type: boolean, example: false }
 *                       url: { type: string, example: "http://192.168.1.100:8080/preview/11.png" }
 *       503:
 *         description: Could not reach the device
 */
app.get('/api/overlays', async (_req, res) => {
  try {
    const { data: overlays, stale } = await cachedQuery('getMaterialList');
    res.json({ success: true, overlays, stale });
  } catch (error) {
    res.status(503).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/overlay:
 *   post:
 *     summary: Show or hide an overlay by id
 *     description: Sends an order_material_change command to the YoloBox. Get valid ids from GET /api/overlays. Set isSelected to true to show the overlay, false to hide it.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, isSelected]
 *             properties:
 *               id:
 *                 type: string
 *                 description: The overlay id from GET /api/overlays
 *                 example: "type=lower_third&overlayId=11"
 *               isSelected:
 *                 type: boolean
 *                 description: true to show the overlay, false to hide it
 *                 example: true
 *     responses:
 *       200:
 *         description: Overlay command dispatched
 *       400:
 *         description: Missing id or isSelected
 *       503:
 *         description: Command Socket is not connected
 */
app.post('/api/overlay', (req, res) => {
  const id = req.body?.id;
  const isSelected = req.body?.isSelected;
  if (id === undefined || id === null || id === '') {
    return res.status(400).json({ success: false, error: 'Body must include an "id" (get it from GET /api/overlays)' });
  }
  if (typeof isSelected !== 'boolean') {
    return res.status(400).json({ success: false, error: 'Body must include a boolean "isSelected" (true to show, false to hide)' });
  }
  if (!commandSocket || commandSocket.readyState !== WebSocket.OPEN) {
    return res.status(503).json({ success: false, error: 'Command Socket is not connected' });
  }
  const order = { data: { id: String(id), isSelected }, orderID: 'order_material_change' };
  commandSocket.send(JSON.stringify(order));
  _queryCache.delete('getMaterialList'); // state changed — next read must be fresh
  // Single chokepoint for overlay toggles — fires for both the Yolobox tab and the timeline.
  console.log(`[YOLO→DEVICE] overlay ${isSelected ? 'show' : 'hide'} → id=${id}`);
  res.json({ success: true, message: `Overlay ${isSelected ? 'show' : 'hide'} dispatched (id=${id})` });
});

/**
 * @swagger
 * /api/audio:
 *   get:
 *     summary: List the YoloBox audio channels (mixer)
 *     description: Live-queries the device's getMixerList endpoint. Each channel's `id` is what you pass to POST /api/audio/mute. `isSelected` false means the channel is currently muted (dropped from the program mix); `volume` is its level 0.0-1.0.
 *     responses:
 *       200:
 *         description: Mixer list retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 channels:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, example: "Program" }
 *                       mixerName: { type: string, example: "Program" }
 *                       volume: { type: number, example: 0.7 }
 *                       AFV: { type: boolean, example: false }
 *                       isSelected: { type: boolean, example: true }
 *       503:
 *         description: Could not reach the device
 */
app.get('/api/audio', async (_req, res) => {
  try {
    const { data: channels, stale } = await cachedQuery('getMixerList');
    res.json({ success: true, channels, stale });
  } catch (error) {
    res.status(503).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/audio/mute:
 *   post:
 *     summary: Mute or unmute an audio channel by id
 *     description: Toggles a channel's isSelected flag (mute = isSelected false, unmute = true) via order_mixer_change. Reads the channel's current state first and echoes back volume and AFV so they are preserved. Get valid ids from GET /api/audio.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, muted]
 *             properties:
 *               id:
 *                 type: string
 *                 description: The channel id from GET /api/audio
 *                 example: "Program"
 *               muted:
 *                 type: boolean
 *                 description: true to mute the channel, false to unmute
 *                 example: true
 *     responses:
 *       200:
 *         description: Mute command dispatched
 *       400:
 *         description: Missing id or muted
 *       404:
 *         description: No channel matches the given id
 *       503:
 *         description: Command Socket is not connected or device unreachable
 */
app.post('/api/audio/mute', async (req, res) => {
  const id = req.body?.id;
  const muted = req.body?.muted;
  if (id === undefined || id === null || id === '') {
    return res.status(400).json({ success: false, error: 'Body must include an "id" (get it from GET /api/audio)' });
  }
  if (typeof muted !== 'boolean') {
    return res.status(400).json({ success: false, error: 'Body must include a boolean "muted" (true to mute, false to unmute)' });
  }
  if (!commandSocket || commandSocket.readyState !== WebSocket.OPEN) {
    return res.status(503).json({ success: false, error: 'Command Socket is not connected' });
  }

  let channels;
  try {
    channels = await queryEndpoint('getMixerList');
  } catch (error) {
    return res.status(503).json({ success: false, error: `Could not read mixer state: ${error.message}` });
  }

  const channel = Array.isArray(channels) && channels.find((c) => String(c.id) === String(id));
  if (!channel) {
    return res.status(404).json({ success: false, error: `No audio channel with id "${id}"` });
  }

  const order = {
    data: { id: String(id), isSelected: !muted, volume: channel.volume, AFV: channel.AFV },
    orderID: 'order_mixer_change',
  };
  commandSocket.send(JSON.stringify(order));
  console.log('[Command Socket]', muted ? 'Muted' : 'Unmuted', 'audio ->', id);
  res.json({ success: true, message: `Audio ${muted ? 'mute' : 'unmute'} dispatched (id=${id})` });
});

/**
 * @swagger
 * /api/audio:
 *   post:
 *     summary: Set an audio channel's volume, mute (isSelected) and/or AFV
 *     description: Generic mixer set via order_mixer_change. Any omitted field keeps the channel's current value (read from getMixerList first). volume is 0.0-1.0, isSelected true = in the program mix (unmuted), AFV = audio-follows-video.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id]
 *             properties:
 *               id: { type: string, example: "Program" }
 *               volume: { type: number, example: 0.7 }
 *               isSelected: { type: boolean, example: true }
 *               AFV: { type: boolean, example: false }
 *     responses:
 *       200: { description: Mixer change dispatched }
 *       400: { description: Missing id or no settable field }
 *       404: { description: No channel matches the given id }
 *       503: { description: Command Socket is not connected or device unreachable }
 */
app.post('/api/audio', async (req, res) => {
  const { id, volume, isSelected, AFV } = req.body ?? {};
  if (id === undefined || id === null || id === '') {
    return res.status(400).json({ success: false, error: 'Body must include an "id" (get it from GET /api/audio)' });
  }
  if (volume === undefined && isSelected === undefined && AFV === undefined) {
    return res.status(400).json({ success: false, error: 'Body must include at least one of: volume, isSelected, AFV' });
  }
  if (volume !== undefined && (typeof volume !== 'number' || volume < 0 || volume > 1)) {
    return res.status(400).json({ success: false, error: '"volume" must be a number between 0.0 and 1.0' });
  }
  if (!commandSocket || commandSocket.readyState !== WebSocket.OPEN) {
    return res.status(503).json({ success: false, error: 'Command Socket is not connected' });
  }

  let channels;
  try {
    channels = await queryEndpoint('getMixerList');
  } catch (error) {
    return res.status(503).json({ success: false, error: `Could not read mixer state: ${error.message}` });
  }

  const channel = Array.isArray(channels) && channels.find((c) => String(c.id) === String(id));
  if (!channel) {
    return res.status(404).json({ success: false, error: `No audio channel with id "${id}"` });
  }

  const order = {
    data: {
      id: String(id),
      isSelected: typeof isSelected === 'boolean' ? isSelected : channel.isSelected,
      volume: typeof volume === 'number' ? volume : channel.volume,
      AFV: typeof AFV === 'boolean' ? AFV : channel.AFV,
    },
    orderID: 'order_mixer_change',
  };
  commandSocket.send(JSON.stringify(order));
  _queryCache.delete('getMixerList'); // state changed — next read must be fresh
  console.log('[Command Socket] Mixer set ->', id, order.data);
  res.json({ success: true, message: `Mixer change dispatched (id=${id})` });
});

/**
 * @swagger
 * /api/status:
 *   get:
 *     summary: Get current YoloBox device status
 *     description: Returns the most recently cached JSON payload received from the Status Socket
 *     responses:
 *       200:
 *         description: Successfully retrieved device status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   description: Cached status payload from YoloBox (battery, bitrate, active scene, etc.)
 *                   example: {}
 *       503:
 *         description: Status Socket is not connected or no status cached yet
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 */
app.get('/api/status', (_req, res) => {
  if (statusSocket && statusSocket.readyState === WebSocket.OPEN && cachedStatus) {
    res.json({ success: true, data: cachedStatus });
  } else {
    res.status(503).json({
      success: false,
      error: 'Status Socket not connected or no status cached yet',
    });
  }
});

/**
 * @swagger
 * /api/live:
 *   get:
 *     summary: Get the current live (streaming) status
 *     description: Live-queries the device's getLiveStatus endpoint. `living` is true while the box is streaming/recording; `startTime` is when it went live.
 *     responses:
 *       200:
 *         description: Live status retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 living: { type: boolean, example: false }
 *                 startTime: { type: integer, example: 0 }
 *       503:
 *         description: Device not reachable
 *   post:
 *     summary: Start or stop the live stream
 *     description: 'Sends an order_live_status command. Body `{ "status": "start" }` goes live, `{ "status": "stop" }` ends it. Omit `status` to toggle based on the current live state.'
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status: { type: string, enum: [start, stop], example: start }
 *     responses:
 *       200:
 *         description: Live command dispatched
 *       503:
 *         description: Command Socket is not connected
 */
app.get('/api/live', async (_req, res) => {
  try {
    const { data: result, stale } = await cachedQuery('getLiveStatus');
    res.json({ success: true, living: !!result?.living, startTime: result?.startTime ?? 0, stale });
  } catch (error) {
    res.status(503).json({ success: false, error: error.message || 'Could not read live status' });
  }
});

app.post('/api/live', async (req, res) => {
  if (!commandSocket || commandSocket.readyState !== WebSocket.OPEN) {
    return res.status(503).json({ success: false, error: 'Command Socket is not connected' });
  }
  let status = req.body?.status;
  if (status !== 'start' && status !== 'stop') {
    // No explicit status — toggle from the device's current live state.
    try {
      const cur = await queryEndpoint('getLiveStatus');
      status = cur?.living ? 'stop' : 'start';
    } catch {
      return res.status(503).json({ success: false, error: 'Could not read current live status to toggle' });
    }
  }
  const order = { data: { status }, orderID: 'order_live_status' };
  commandSocket.send(JSON.stringify(order));
  _queryCache.delete('getLiveStatus'); // state changed — next read must be fresh
  console.log('[Command Socket] Live status ->', status);
  res.json({ success: true, status, message: `Live ${status} dispatched` });
});

/**
 * @swagger
 * /api/scoreboard:
 *   get:
 *     summary: Get the current scoreboard state
 *     description: Live-queries the device's getScoreboardInfo endpoint. Returns the two teams (teamName + score), the current period, the match timer (timeSetting), whether the scoreboard overlay is shown, and its type. Added in the firmware that ships the local Web Control UI.
 *     responses:
 *       200:
 *         description: Scoreboard state retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 scoreboard:
 *                   type: object
 *                   properties:
 *                     showScoreboard: { type: boolean, example: true }
 *                     period: { type: string, example: "First Half" }
 *                     type: { type: integer, example: 0 }
 *                     teams:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           teamName: { type: string, example: "Team 1" }
 *                           score: { type: integer, example: 0 }
 *                     timeSetting:
 *                       type: object
 *                       properties:
 *                         isCountdown: { type: boolean, example: false }
 *                         isPlaying: { type: boolean, example: false }
 *                         seconds: { type: integer, example: 0 }
 *                         showTime: { type: boolean, example: false }
 *       503:
 *         description: Could not reach the device
 */
app.get('/api/scoreboard', async (_req, res) => {
  try {
    const { data: scoreboard, stale } = await cachedQuery('getScoreboardInfo');
    res.json({ success: true, scoreboard, stale });
  } catch (error) {
    res.status(503).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/command:
 *   post:
 *     summary: Send a command to the YoloBox
 *     description: Accepts a generic JSON payload and forwards it to the YoloBox via the Command Socket
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             example:
 *               id: 1
 *               action: "some_action"
 *               params: {}
 *     responses:
 *       200:
 *         description: Command successfully dispatched to YoloBox
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid request payload
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *       503:
 *         description: Command Socket is not connected
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 */
app.post('/api/command', (req, res) => {
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({
      success: false,
      error: 'Request body must be a valid JSON object',
    });
  }

  if (!commandSocket || commandSocket.readyState !== WebSocket.OPEN) {
    return res.status(503).json({
      success: false,
      error: 'Command Socket is not connected',
    });
  }

  try {
    commandSocket.send(JSON.stringify(payload));
    console.log('[Command Socket] Sent payload:', payload);
    res.json({ success: true, message: 'Command dispatched' });
  } catch (error) {
    console.error('[Command Socket] Error sending payload:', error.message);
    res.status(503).json({
      success: false,
      error: 'Failed to send command',
    });
  }
});

/**
 * @swagger
 * /api/health:
 *   get:
 *     summary: Health check endpoint
 *     description: Returns the current connection status of both WebSocket sockets
 *     responses:
 *       200:
 *         description: Health status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 commandSocket:
 *                   type: string
 *                   enum: [CONNECTING, OPEN, CLOSING, CLOSED]
 *                 statusSocket:
 *                   type: string
 *                   enum: [CONNECTING, OPEN, CLOSING, CLOSED]
 *                 cachedStatusAvailable:
 *                   type: boolean
 */
app.get('/api/health', (_req, res) => {
  const getSocketState = (socket) => {
    if (!socket) return 'CLOSED';
    switch (socket.readyState) {
      case WebSocket.CONNECTING:
        return 'CONNECTING';
      case WebSocket.OPEN:
        return 'OPEN';
      case WebSocket.CLOSING:
        return 'CLOSING';
      case WebSocket.CLOSED:
        return 'CLOSED';
      default:
        return 'UNKNOWN';
    }
  };

  res.json({
    success: true,
    device: `${YOLOBOX_IP}:${WS_PORT}`,
    authSocket: getSocketState(authSocket),
    authenticated,
    commandSocket: getSocketState(commandSocket),
    statusSocket: getSocketState(statusSocket),
    cachedStatusAvailable: cachedStatus !== null,
    lastError: lastSocketError,
  });
});

// ============================================================================
// Server Initialization
// ============================================================================

app.listen(PORT, () => {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`YoloBox Ultra REST-to-WebSocket Relay API`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Swagger documentation available at http://localhost:${PORT}/api/doc`);
  console.log(`YoloBox target: ws://${YOLOBOX_IP}:${WS_PORT}`);
  console.log(`${'='.repeat(70)}\n`);

  // Authorize the session first; the command/status sockets come up once it's open.
  connectAuthSocket();
});
