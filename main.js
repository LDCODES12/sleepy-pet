const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, Notification, globalShortcut } = require('electron');
const { autoUpdater } = require('electron-updater');
const { createMacUpdater } = require('./mac-updater');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let mainWindow;
let roomWindow;
let tray;
let mochiHidden = false;
let macUpdater;
let updateCheckTimer = null;
const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
let windowsUpdateState = { status: 'idle', version: null };
let petMessageConfig = {
  userId: null,
  catName: 'Mochi',
  relayUrl: '',
  appearance: {}
};
let petMessagePollTimer = null;
let petMessageStreamController = null;
let petMessageStreamRestartTimer = null;
let petMessageLastPollAt = 0;
let petMessageInboxKey = '';
const seenPetMessageIds = new Set();

// Window large enough for room view (340x440) plus a wider cat stage so
// long-tail frames are not clipped by the transparent window bounds.
const WIN_W = 372;
const WIN_H = 440;

// Keep these in sync with the visible cat canvas in index.html.
const CAT_STAGE_W = 128;
const CAT_STAGE_H = 80;
const CAT_CANVAS_LEFT = WIN_W + 12 - CAT_STAGE_W; // CSS right:-12px
const CAT_CANVAS_TOP = WIN_H - 4 - CAT_STAGE_H; // CSS bottom:4px
const CAT_CENTER_X = CAT_CANVAS_LEFT + 80;
const CAT_FACE_LEFT_X = CAT_CANVAS_LEFT + 53;
const CAT_FACE_RIGHT_X = CAT_CANVAS_LEFT + 102;
const CAT_FACE_Y = CAT_CANVAS_TOP + 37;
// Follow mode pins the cat canvas to the top-left of the window in renderer,
// so use local canvas coordinates for target math.
const FOLLOW_CAT_CENTER_X = 80;
const FOLLOW_CAT_FACE_LEFT_X = 53;
const FOLLOW_CAT_FACE_RIGHT_X = 102;
const FOLLOW_CAT_FACE_Y = 37;
const FOLLOW_TICK_MS = 16;
const FOLLOW_LERP = 0.2;
const FOLLOW_MAX_STEP = 96;
const FOLLOW_SCREEN_OVERSCAN = 96;
const PET_MESSAGE_POLL_MS = 8000;
const PET_MESSAGE_TIMEOUT_MS = 8000;
const PET_MESSAGE_MAX_TEXT = 180;
const PET_MESSAGE_MAX_NAME = 24;
const PET_MESSAGE_MAX_ID = 64;
const PET_MESSAGE_DEFAULT_RELAY_URL = 'https://ntfy.sh';
const PET_MESSAGE_NTFY_CATCHUP = '10m';
const PET_MESSAGE_TOPIC_PREFIX = 'sleepy-pet-';

// ── Group rooms ──
const GROUP_TOPIC_PREFIX = 'sleepy-pet-group-';
const GROUP_HEARTBEAT_INTERVAL_MS = 15000;
const GROUP_MESSAGE_MAX_TEXT = 180;
const GROUP_NAME_MAX = 40;
const GROUP_ID_MAX = 32;
const GROUP_CACHE_MAX_CHAT = 80;
const GROUP_CACHE_MAX_MEMBERS = 80;
let groupConfig = {
  groups: [],
  userId: null,
  catName: 'Mochi',
  appearance: {},
  catState: 'awake',
  catSleeping: false
};
const groupStreams = new Map(); // groupId -> { controller, restartTimer }
const groupSeenMessageIds = new Set();
const groupPresenceCache = new Map(); // groupId -> Map<userId, member>
const groupChatCache = new Map(); // groupId -> Array<message>
const groupRoomPositions = new Map(); // groupId -> { x, y, updatedAt }
let groupHeartbeatTimer = null;
let groupCacheLoaded = false;
let groupCacheSaveTimer = null;
let currentRoomContext = { mode: 'edit', groupId: null, groupName: null };

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  createWindow();
  createTray();

  setupAutoUpdates();

  // Global shortcut: Cmd+Shift+M opens Mochi's in-app menu
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    mainWindow?.webContents.send('open-menu');
  });
});

function createUpdaterLogger() {
  const logPath = path.join(app.getPath('userData'), 'mac-updater.log');
  const format = (level, args) => {
    const body = args.map(arg => {
      if (arg instanceof Error) return arg.stack || arg.message;
      if (typeof arg === 'string') return arg;
      try { return JSON.stringify(arg); } catch { return String(arg); }
    }).join(' ');
    return `[${new Date().toISOString()}] [${level}] ${body}\n`;
  };
  const append = (level, args) => {
    const line = format(level, args);
    try { fs.appendFileSync(logPath, line); } catch { /* ignore log write failures */ }
    if (level === 'warn' || level === 'error') console.error(line.trimEnd());
    else console.log(line.trimEnd());
  };
  return {
    info: (...a) => append('info', a),
    warn: (...a) => append('warn', a),
    error: (...a) => append('error', a)
  };
}

function setupAutoUpdates() {
  if (process.platform === 'darwin') {
    const logger = createUpdaterLogger();
    macUpdater = createMacUpdater({
      app,
      Notification,
      logger,
      onStateChange: () => {
        updateTrayMenu();
        broadcastUpdateState();
      }
    });
    // Clean any leftover staging directories from a prior install cycle
    // before anything else happens. This is the fix for the 1.2.8→1.2.9
    // stuck-update bug: a held-open file inside pending-mac-update/ blocked
    // the first rm in downloadAndPrepareUpdate and the check bailed silently.
    macUpdater.cleanStaleStaging().catch(() => {});
    setTimeout(() => {
      macUpdater.checkForUpdates({ silent: false }).catch(() => {});
    }, 3000);
    // Retry periodically so a single transient failure (network blip, stale
    // redirect, busy file) doesn't leave us stuck until the next relaunch.
    updateCheckTimer = setInterval(() => {
      macUpdater.checkForUpdates({ silent: true }).catch(() => {});
    }, UPDATE_CHECK_INTERVAL_MS);
    return;
  }

  // Auto-update from public GitHub releases on platforms where electron-updater
  // does not require Apple/Squirrel code-signature validation.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => {
    windowsUpdateState = { status: 'checking', version: null };
    updateTrayMenu();
    broadcastUpdateState();
  });
  autoUpdater.on('update-available', (info) => {
    windowsUpdateState = { status: 'downloading', version: info?.version || null };
    updateTrayMenu();
    broadcastUpdateState();
  });
  autoUpdater.on('update-not-available', () => {
    windowsUpdateState = { status: 'idle', version: null };
    updateTrayMenu();
    broadcastUpdateState();
  });
  autoUpdater.on('update-downloaded', (info) => {
    windowsUpdateState = { status: 'ready', version: info?.version || null };
    updateTrayMenu();
    broadcastUpdateState();
  });
  autoUpdater.on('error', () => {
    windowsUpdateState = { status: 'error', version: null };
    updateTrayMenu();
    broadcastUpdateState();
  });
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: width - WIN_W - 10,
    y: height - WIN_H - 10,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.webContents.on('did-finish-load', () => {
    broadcastFollowState();
    broadcastUpdateState();
    broadcastPetMessageStatus();
  });
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setAlwaysOnTop(true, 'floating');

  // Click-through for transparent areas, but forward mouse events on content
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// Renderer tells us when mouse enters/leaves visible content
ipcMain.on('set-ignore-mouse', (_, ignore) => {
  if (!mainWindow) return;
  mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
});

function createTrayIcon() {
  const s = 22;
  const buf = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      let a = 0;
      if (Math.hypot(x - 11, y - 12) < 6) a = 210;
      if (x >= 5 && x <= 8 && y >= 4 && y <= 8 && x - 5 <= 8 - y) a = 210;
      if (x >= 14 && x <= 17 && y >= 4 && y <= 8 && 17 - x <= 8 - y) a = 210;
      buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = a;
    }
  }
  try {
    const img = nativeImage.createFromBitmap(buf, { width: s, height: s });
    img.setTemplateImage(true);
    return img;
  } catch { return nativeImage.createEmpty(); }
}

function updateTrayMenu() {
  if (!tray) return;

  const updateState = getUpdateState();
  const items = [
    { label: mochiHidden ? 'Show Mochi' : 'Hide Mochi', click: () => {
      if (mochiHidden) { showMochi(); }
      else { hideMochi(); }
    }},
    { label: followMouse ? 'Stop Following' : 'Follow Mouse', click: () => {
      setFollowMouseEnabled(!followMouse);
    }},
    { label: 'Reset Position', click: resetPosition }
  ];

  items.push({ type: 'separator' });
  if (updateState?.status === 'ready') {
    items.push({
      label: `Restart to Update ${updateState.version || ''}`.trim(),
      click: installUpdateNow
    });
  } else if (updateState?.status === 'downloading') {
    items.push({
      label: updateState.version
        ? `Downloading Update ${updateState.version}\u2026`
        : 'Downloading Update\u2026',
      enabled: false
    });
  } else if (updateState?.status === 'checking') {
    items.push({ label: 'Checking for Update\u2026', enabled: false });
  } else if (updateState?.status === 'error') {
    items.push({
      label: 'Update check failed — Retry',
      click: triggerManualUpdateCheck
    });
  } else {
    items.push({
      label: 'Check for Updates',
      click: triggerManualUpdateCheck
    });
  }

  items.push(
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  );

  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Sleepy Pet');
  updateTrayMenu();
  tray.on('click', () => { if (mochiHidden) showMochi(); });
}

function hideMochi() {
  if (!mainWindow) return;
  mochiHidden = true;
  // Tell renderer to stop drawing — canvas clears to transparent, window becomes invisible
  mainWindow.webContents.send('mochi-visible', false);
  // Fully ignore mouse (no forward) — OS treats window as non-existent for clicks
  mainWindow.setIgnoreMouseEvents(true);
  updateTrayMenu();
}

function showMochi() {
  if (!mainWindow) return;
  mochiHidden = false;
  // Tell renderer to resume drawing
  mainWindow.webContents.send('mochi-visible', true);
  // Re-enable click-through with forward so renderer can detect mouse on content
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  updateTrayMenu();
}

function resetPosition() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow?.setPosition(width - WIN_W - 10, height - WIN_H - 10);
}

function createRoomWindow(initialMode = 'edit', options = {}) {
  const mode = initialMode === 'play' ? 'play' : 'edit';
  const groupId = options.groupId ? sanitizeGroupId(options.groupId) : null;
  const groupName = options.groupName
    ? sanitizeText(options.groupName, GROUP_NAME_MAX) || null
    : null;

  if (roomWindow) {
    roomWindow.focus();
    currentRoomContext = { mode, groupId, groupName };
    roomWindow.setTitle(groupId ? `${groupName || 'Group'} — Sleepy Pet` : "Mochi's Room");
    roomWindow.webContents.send('set-room-mode', { mode, groupId, groupName });
    return;
  }

  const title = groupId
    ? `${groupName || 'Group'} — Sleepy Pet`
    : "Mochi's Room";

  roomWindow = new BrowserWindow({
    width: 900,
    height: 650,
    title,
    resizable: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'room-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  currentRoomContext = { mode, groupId, groupName };
  const query = { mode };
  if (groupId) query.groupId = groupId;
  if (groupName) query.groupName = groupName;
  roomWindow.loadFile('room.html', { query });
  roomWindow.on('closed', () => {
    roomWindow = null;
    currentRoomContext = { mode: 'edit', groupId: null, groupName: null };
  });
}

// Follow-mouse feature
let followMouse = false;
let followInterval = null;
let followOriginPosition = null;

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function getVirtualDisplayBounds() {
  const displays = screen.getAllDisplays();
  const allBounds = displays.length ? displays.map((display) => display.bounds) : [screen.getPrimaryDisplay().bounds];
  const minX = Math.min(...allBounds.map((bounds) => bounds.x));
  const minY = Math.min(...allBounds.map((bounds) => bounds.y));
  const maxX = Math.max(...allBounds.map((bounds) => bounds.x + bounds.width));
  const maxY = Math.max(...allBounds.map((bounds) => bounds.y + bounds.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function getFollowCatMetricsForState(enabled) {
  if (enabled) {
    return {
      centerX: FOLLOW_CAT_CENTER_X,
      faceLeftX: FOLLOW_CAT_FACE_LEFT_X,
      faceRightX: FOLLOW_CAT_FACE_RIGHT_X,
      faceY: FOLLOW_CAT_FACE_Y
    };
  }
  return {
    centerX: CAT_CENTER_X,
    faceLeftX: CAT_FACE_LEFT_X,
    faceRightX: CAT_FACE_RIGHT_X,
    faceY: CAT_FACE_Y
  };
}

function getFollowCatMetrics() {
  return getFollowCatMetricsForState(followMouse);
}

function alignWindowForFollowModeToggle(nextEnabled) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const oldMetrics = getFollowCatMetricsForState(followMouse);
    const newMetrics = getFollowCatMetricsForState(nextEnabled);
    const [wx, wy] = mainWindow.getPosition();
    const cursor = screen.getCursorScreenPoint();
    const wasFacingLeft = cursor.x < wx + oldMetrics.centerX;
    const oldFaceX = wasFacingLeft ? oldMetrics.faceLeftX : oldMetrics.faceRightX;
    const newFaceX = wasFacingLeft ? newMetrics.faceLeftX : newMetrics.faceRightX;
    const nextX = Math.round(wx + (oldFaceX - newFaceX));
    const nextY = Math.round(wy + (oldMetrics.faceY - newMetrics.faceY));
    if (isSafeWindowCoord(nextX) && isSafeWindowCoord(nextY)) {
      mainWindow.setPosition(nextX, nextY);
    }
  } catch {}
}

function clampFollowTarget(x, y, metrics) {
  const bounds = getVirtualDisplayBounds();
  const minFaceX = Math.min(metrics.faceLeftX, metrics.faceRightX);
  const maxFaceX = Math.max(metrics.faceLeftX, metrics.faceRightX);
  return {
    x: clamp(
      x,
      bounds.x - maxFaceX - FOLLOW_SCREEN_OVERSCAN,
      bounds.x + bounds.width - minFaceX + FOLLOW_SCREEN_OVERSCAN
    ),
    y: clamp(
      y,
      bounds.y - metrics.faceY - FOLLOW_SCREEN_OVERSCAN,
      bounds.y + bounds.height - metrics.faceY + FOLLOW_SCREEN_OVERSCAN
    )
  };
}

function nextFollowCoord(current, target) {
  const delta = target - current;
  if (!Number.isFinite(delta)) return current;
  if (Math.abs(delta) < 1) return Math.round(target);
  const step = clamp(delta * FOLLOW_LERP, -FOLLOW_MAX_STEP, FOLLOW_MAX_STEP);
  return Math.round(current + step);
}

function isSafeWindowCoord(n) {
  return Number.isFinite(n) && Math.abs(n) < 100000;
}

function startFollowMouse() {
  if (followInterval) return;
  followInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !followMouse) return;
    try {
      const cursor = screen.getCursorScreenPoint();
      const [wx, wy] = mainWindow.getPosition();
      const metrics = getFollowCatMetrics();
      const facingLeft = cursor.x < wx + metrics.centerX;
      const faceX = facingLeft ? metrics.faceLeftX : metrics.faceRightX;
      const target = clampFollowTarget(cursor.x - faceX, cursor.y - metrics.faceY, metrics);
      const newX = nextFollowCoord(wx, target.x);
      const newY = nextFollowCoord(wy, target.y);
      if (!isSafeWindowCoord(newX) || !isSafeWindowCoord(newY)) return;
      if (newX !== wx || newY !== wy) {
        mainWindow.setPosition(newX, newY);
      }
      if (!mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('cursor-dir', facingLeft ? 'left' : 'right');
      }
    } catch (err) {
      console.error('Follow mouse update failed:', err);
    }
  }, FOLLOW_TICK_MS);
}

function stopFollowMouse() {
  if (followInterval) { clearInterval(followInterval); followInterval = null; }
}

function broadcastFollowState() {
  mainWindow?.webContents.send('follow-state', followMouse);
}

function getUpdateState() {
  if (process.platform === 'darwin') {
    const state = macUpdater?.getState?.();
    return {
      status: state?.status || 'idle',
      version: state?.version || null
    };
  }
  return windowsUpdateState;
}

function broadcastUpdateState() {
  const state = getUpdateState();
  mainWindow?.webContents.send('update-state', {
    ready: state?.status === 'ready',
    version: state?.version || null,
    status: state?.status || 'idle'
  });
}

function installUpdateNow() {
  if (process.platform === 'darwin') {
    macUpdater?.installNow?.();
    return;
  }
  if (windowsUpdateState.status === 'ready') {
    autoUpdater.quitAndInstall();
  }
}

function triggerManualUpdateCheck() {
  if (process.platform === 'darwin') {
    macUpdater?.checkForUpdates?.({ silent: false }).catch(() => {});
    return;
  }
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}

function sanitizeText(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function sanitizeMessageId(value) {
  return sanitizeText(value, PET_MESSAGE_MAX_ID)
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, PET_MESSAGE_MAX_ID);
}

function sanitizeRelayUrl(value) {
  const raw = String(value || process.env.SLEEPY_PET_MESSAGE_RELAY_URL || PET_MESSAGE_DEFAULT_RELAY_URL).trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function sanitizeAppearance(appearance = {}) {
  const selectedRibbon = sanitizeText(appearance.selectedRibbon, 18);
  const selectedSkin = sanitizeText(appearance.selectedSkin, 40);
  return {
    selectedRibbon: selectedRibbon || null,
    selectedSkin: selectedSkin || null
  };
}

function sanitizePetMessageConfig(config = {}) {
  return {
    userId: sanitizeMessageId(config.userId),
    catName: sanitizeText(config.catName || 'Mochi', PET_MESSAGE_MAX_NAME) || 'Mochi',
    relayUrl: sanitizeRelayUrl(config.relayUrl),
    appearance: sanitizeAppearance(config.appearance)
  };
}

function makePetMessageId() {
  return `msg-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
}

function sanitizePetMessage(message = {}) {
  const from = message.from || {};
  const fromId = sanitizeMessageId(from.id || from.userId || message.fromId || message.fromUserId || petMessageConfig.userId);
  const fromCatName = sanitizeText(from.catName || message.catName || 'Mochi', PET_MESSAGE_MAX_NAME) || 'Mochi';
  const text = sanitizeText(message.text || message.message, PET_MESSAGE_MAX_TEXT);

  return {
    id: sanitizeMessageId(message.id) || makePetMessageId(),
    to: sanitizeMessageId(message.to || message.recipientId),
    text,
    sentAt: sanitizeText(message.sentAt, 40) || new Date().toISOString(),
    demo: Boolean(message.demo),
    from: {
      id: fromId,
      catName: fromCatName,
      appearance: sanitizeAppearance(from.appearance || message.appearance)
    }
  };
}

function petMessageRelayUrl(pathname = 'messages') {
  if (!petMessageConfig.relayUrl) return null;
  const base = petMessageConfig.relayUrl.endsWith('/')
    ? petMessageConfig.relayUrl
    : `${petMessageConfig.relayUrl}/`;
  return new URL(pathname.replace(/^\//, ''), base);
}

function petMessageRelayKind() {
  if (!petMessageConfig.relayUrl) return 'preview';
  try {
    const url = new URL(petMessageConfig.relayUrl);
    if (url.hostname === 'ntfy.sh' || url.pathname.endsWith('/ntfy')) return 'ntfy';
  } catch {}
  return 'sleepy';
}

function petMessageTopicForUser(userId) {
  const safeId = sanitizeMessageId(userId).toLowerCase();
  return `${PET_MESSAGE_TOPIC_PREFIX}${safeId}`.slice(0, 64);
}

function petMessageNtfyUrl(userId, format = '') {
  if (!petMessageConfig.relayUrl) return null;
  const base = petMessageConfig.relayUrl.endsWith('/')
    ? petMessageConfig.relayUrl
    : `${petMessageConfig.relayUrl}/`;
  const topic = petMessageTopicForUser(userId);
  return new URL(`${encodeURIComponent(topic)}${format}`, base);
}

async function fetchPetMessageJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PET_MESSAGE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      throw new Error(`Relay responded with ${response.status}`);
    }
    return response.status === 204 ? null : response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPetMessageText(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PET_MESSAGE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Relay responded with ${response.status}`);
    }
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

function rememberPetMessageId(id) {
  if (!id) return;
  seenPetMessageIds.add(id);
  if (seenPetMessageIds.size <= 500) return;
  const oldest = seenPetMessageIds.values().next().value;
  seenPetMessageIds.delete(oldest);
}

function petMessageInboxKeyForConfig(config = petMessageConfig) {
  if (!config.userId || !config.relayUrl) return '';
  return `${sanitizeRelayUrl(config.relayUrl)}:${sanitizeMessageId(config.userId).toLowerCase()}`;
}

function broadcastPetMessageStatus(extra = {}) {
  const relayUrl = petMessageConfig.relayUrl || '';
  mainWindow?.webContents.send('pet-message-status', {
    relayEnabled: Boolean(relayUrl),
    relayKind: petMessageRelayKind(),
    relayUrl,
    userId: petMessageConfig.userId || null,
    ...extra
  });
}

function deliverPetMessage(message) {
  const safeMessage = sanitizePetMessage(message);
  if (!safeMessage.text) return false;
  rememberPetMessageId(safeMessage.id);
  if (mochiHidden) showMochi();
  mainWindow?.webContents.send('pet-message-received', safeMessage);
  return true;
}

async function pollPetMessages() {
  if (!petMessageConfig.userId || !petMessageConfig.relayUrl) return;

  const url = petMessageRelayUrl('messages');
  if (!url) return;
  url.searchParams.set('to', petMessageConfig.userId);
  if (petMessageLastPollAt) {
    url.searchParams.set('since', String(petMessageLastPollAt));
  }

  try {
    const payload = await fetchPetMessageJson(url);
    const messages = Array.isArray(payload) ? payload : (payload?.messages || []);
    for (const rawMessage of messages) {
      const message = sanitizePetMessage(rawMessage);
      if (!message.text || !message.id || seenPetMessageIds.has(message.id)) continue;
      if (message.to && message.to !== petMessageConfig.userId) continue;
      deliverPetMessage(message);
    }
    petMessageLastPollAt = Date.now();
    broadcastPetMessageStatus({ status: 'connected' });
  } catch (error) {
    broadcastPetMessageStatus({
      status: 'error',
      error: sanitizeText(error.message || error, 120)
    });
  }
}

function handleNtfyPetMessageLine(line) {
  if (!line) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.event === 'open') {
    broadcastPetMessageStatus({ status: 'connected', relayKind: 'ntfy' });
    return;
  }
  if (event.event !== 'message' || !event.message) return;

  let rawMessage;
  try {
    rawMessage = JSON.parse(event.message);
  } catch {
    return;
  }

  const message = sanitizePetMessage(rawMessage);
  if (!message.text || !message.id || seenPetMessageIds.has(message.id)) return;
  if (message.to && message.to !== petMessageConfig.userId) return;
  deliverPetMessage(message);
}

async function startNtfyPetMessageStream() {
  if (!petMessageConfig.userId || !petMessageConfig.relayUrl) return;
  const url = petMessageNtfyUrl(petMessageConfig.userId, '/json');
  if (!url) return;
  url.searchParams.set('since', PET_MESSAGE_NTFY_CATCHUP);

  petMessageStreamController = new AbortController();
  const controller = petMessageStreamController;

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Relay responded with ${response.status}`);
    if (!response.body?.getReader) throw new Error('Relay stream is not available');

    broadcastPetMessageStatus({ status: 'connected', relayKind: 'ntfy' });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (!controller.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        handleNtfyPetMessageLine(line);
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      broadcastPetMessageStatus({
        status: 'error',
        relayKind: 'ntfy',
        error: sanitizeText(error.message || error, 120)
      });
    }
  } finally {
    if (petMessageStreamController === controller) {
      petMessageStreamController = null;
    }
    if (!controller.signal.aborted && petMessageRelayKind() === 'ntfy') {
      petMessageStreamRestartTimer = setTimeout(startNtfyPetMessageStream, 4000);
    }
  }
}

function stopPetMessagePolling() {
  if (petMessagePollTimer) {
    clearInterval(petMessagePollTimer);
    petMessagePollTimer = null;
  }
  if (petMessageStreamRestartTimer) {
    clearTimeout(petMessageStreamRestartTimer);
    petMessageStreamRestartTimer = null;
  }
  if (petMessageStreamController) {
    petMessageStreamController.abort();
    petMessageStreamController = null;
  }
}

function startPetMessagePolling() {
  stopPetMessagePolling();
  if (!petMessageConfig.userId || !petMessageConfig.relayUrl) {
    broadcastPetMessageStatus({ status: petMessageConfig.relayUrl ? 'missing-code' : 'preview' });
    return;
  }
  if (petMessageRelayKind() === 'ntfy') {
    broadcastPetMessageStatus({ status: 'connecting', relayKind: 'ntfy' });
    startNtfyPetMessageStream();
    return;
  }
  pollPetMessages();
  petMessagePollTimer = setInterval(pollPetMessages, PET_MESSAGE_POLL_MS);
}

async function sendPetMessage(payload) {
  const message = sanitizePetMessage({
    ...payload,
    from: {
      id: petMessageConfig.userId,
      catName: petMessageConfig.catName,
      appearance: petMessageConfig.appearance,
      ...(payload?.from || {})
    }
  });

  if (!message.to) {
    return { ok: false, error: 'Choose a friend code first.' };
  }
  if (!message.text) {
    return { ok: false, error: 'Write a message first.' };
  }

  if (petMessageRelayKind() === 'ntfy') {
    const url = petMessageNtfyUrl(message.to);
    if (!url) return { ok: false, error: 'Relay is not ready yet.' };
    try {
      await fetchPetMessageText(url, {
        method: 'POST',
        headers: {
          title: message.from.catName,
          tags: 'cat'
        },
        body: JSON.stringify(message)
      });
      return { ok: true, mode: 'ntfy', message: 'Sent.' };
    } catch (error) {
      return {
        ok: false,
        error: sanitizeText(error.message || error, 120)
      };
    }
  }

  const url = petMessageRelayUrl('messages');
  if (!url) {
    setTimeout(() => {
      deliverPetMessage({
        ...message,
        to: petMessageConfig.userId,
        demo: true
      });
    }, 550);
    return {
      ok: true,
      mode: 'preview',
      message: 'No relay is set, so Mochi previewed it here.'
    };
  }

  try {
    await fetchPetMessageJson(url, {
      method: 'POST',
      body: JSON.stringify(message)
    });
    return { ok: true, mode: 'relay', message: 'Sent.' };
  } catch (error) {
    return {
      ok: false,
      error: sanitizeText(error.message || error, 120)
    };
  }
}

// ═══════ GROUP ROOMS ═══════
function sanitizeGroupId(id) {
  return String(id || '')
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, GROUP_ID_MAX);
}

function groupTopicForId(id) {
  const safe = sanitizeGroupId(id).toLowerCase();
  return `${GROUP_TOPIC_PREFIX}${safe}`.slice(0, 64);
}

function groupTopicUrl(id, format = '') {
  if (!petMessageConfig.relayUrl) return null;
  const base = petMessageConfig.relayUrl.endsWith('/')
    ? petMessageConfig.relayUrl
    : `${petMessageConfig.relayUrl}/`;
  const topic = groupTopicForId(id);
  if (!topic) return null;
  return new URL(`${encodeURIComponent(topic)}${format}`, base);
}

function groupCachePath() {
  try {
    return path.join(app.getPath('userData'), 'group-cache.json');
  } catch {
    return null;
  }
}

function getGroupPresence(groupId) {
  const id = sanitizeGroupId(groupId);
  if (!groupPresenceCache.has(id)) groupPresenceCache.set(id, new Map());
  return groupPresenceCache.get(id);
}

function getGroupChat(groupId) {
  const id = sanitizeGroupId(groupId);
  if (!groupChatCache.has(id)) groupChatCache.set(id, []);
  return groupChatCache.get(id);
}

function loadGroupCacheOnce() {
  if (groupCacheLoaded) return;
  groupCacheLoaded = true;
  const file = groupCachePath();
  if (!file) return;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    const members = parsed?.members && typeof parsed.members === 'object' ? parsed.members : {};
    for (const [rawGroupId, rawMembers] of Object.entries(members)) {
      const groupId = sanitizeGroupId(rawGroupId);
      if (!groupId || !rawMembers || typeof rawMembers !== 'object') continue;
      const groupMap = getGroupPresence(groupId);
      for (const [rawUserId, rawMember] of Object.entries(rawMembers)) {
        const userId = sanitizeMessageId(rawUserId);
        if (!userId) continue;
        groupMap.set(userId, {
          userId,
          catName: sanitizeText(rawMember?.catName || 'Mochi', PET_MESSAGE_MAX_NAME) || 'Mochi',
          appearance: sanitizeAppearance(rawMember?.appearance),
          catState: sanitizeText(rawMember?.catState || 'awake', 24) || 'awake',
          catSleeping: !!rawMember?.catSleeping,
          lastSeen: Number(rawMember?.lastSeen) || 0,
          sentAt: sanitizeText(rawMember?.sentAt, 40) || null,
          roomX: Number.isFinite(Number(rawMember?.roomX)) ? Number(rawMember.roomX) : null,
          roomY: Number.isFinite(Number(rawMember?.roomY)) ? Number(rawMember.roomY) : null
        });
      }
    }

    const chat = parsed?.chat && typeof parsed.chat === 'object' ? parsed.chat : {};
    for (const [rawGroupId, rawMessages] of Object.entries(chat)) {
      const groupId = sanitizeGroupId(rawGroupId);
      if (!groupId || !Array.isArray(rawMessages)) continue;
      const arr = getGroupChat(groupId);
      for (const rawMessage of rawMessages.slice(-GROUP_CACHE_MAX_CHAT)) {
        const id = sanitizeMessageId(rawMessage?.id);
        const userId = sanitizeMessageId(rawMessage?.userId || rawMessage?.from?.id);
        const text = sanitizeText(rawMessage?.text, GROUP_MESSAGE_MAX_TEXT);
        if (!id || !userId || !text) continue;
        arr.push({
          id,
          userId,
          catName: sanitizeText(rawMessage?.catName || rawMessage?.from?.catName || 'Mochi', PET_MESSAGE_MAX_NAME) || 'Mochi',
          appearance: sanitizeAppearance(rawMessage?.appearance || rawMessage?.from?.appearance),
          text,
          sentAt: sanitizeText(rawMessage?.sentAt, 40) || new Date().toISOString(),
          isOwn: !!rawMessage?.isOwn
        });
        rememberGroupMessageId(groupId, id);
      }
    }
  } catch {
    // A corrupt cache should never stop group rooms from working live.
  }
}

function saveGroupCacheNow() {
  if (!groupCacheLoaded) return;
  const file = groupCachePath();
  if (!file) return;
  const members = {};
  for (const [groupId, map] of groupPresenceCache.entries()) {
    const entries = Array.from(map.entries())
      .sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0))
      .slice(0, GROUP_CACHE_MAX_MEMBERS);
    members[groupId] = Object.fromEntries(entries);
  }
  const chat = {};
  for (const [groupId, messages] of groupChatCache.entries()) {
    chat[groupId] = messages.slice(-GROUP_CACHE_MAX_CHAT);
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, members, chat }, null, 2));
  } catch {
    // Best-effort cache only.
  }
}

function scheduleGroupCacheSave() {
  if (!groupCacheLoaded) return;
  if (groupCacheSaveTimer) clearTimeout(groupCacheSaveTimer);
  groupCacheSaveTimer = setTimeout(() => {
    groupCacheSaveTimer = null;
    saveGroupCacheNow();
  }, 500);
}

function buildGroupEvent(kind, groupId, payload, isOwn = false) {
  return {
    kind,
    groupId: sanitizeGroupId(groupId),
    payload,
    isOwn: !!isOwn
  };
}

function storeGroupPresenceEvent(event) {
  const groupId = sanitizeGroupId(event?.groupId);
  const payload = event?.payload || {};
  const userId = sanitizeMessageId(payload.from?.id);
  if (!groupId || !userId) return;
  const members = getGroupPresence(groupId);
  members.set(userId, {
    userId,
    catName: sanitizeText(payload.from?.catName || 'Mochi', PET_MESSAGE_MAX_NAME) || 'Mochi',
    appearance: sanitizeAppearance(payload.from?.appearance),
    catState: sanitizeText(payload.catState || 'awake', 24) || 'awake',
    catSleeping: !!payload.catSleeping,
    lastSeen: Date.now(),
    sentAt: sanitizeText(payload.sentAt, 40) || new Date().toISOString(),
    roomX: Number.isFinite(Number(payload.roomX)) ? Number(payload.roomX) : null,
    roomY: Number.isFinite(Number(payload.roomY)) ? Number(payload.roomY) : null
  });
  scheduleGroupCacheSave();
}

function storeGroupChatEvent(event) {
  const groupId = sanitizeGroupId(event?.groupId);
  const payload = event?.payload || {};
  const id = sanitizeMessageId(payload.id);
  const userId = sanitizeMessageId(payload.from?.id);
  const text = sanitizeText(payload.text, GROUP_MESSAGE_MAX_TEXT);
  if (!groupId || !id || !userId || !text) return;
  const chat = getGroupChat(groupId);
  if (chat.some(message => message.id === id)) return;
  chat.push({
    id,
    userId,
    catName: sanitizeText(payload.from?.catName || 'Mochi', PET_MESSAGE_MAX_NAME) || 'Mochi',
    appearance: sanitizeAppearance(payload.from?.appearance),
    text,
    sentAt: sanitizeText(payload.sentAt, 40) || new Date().toISOString(),
    isOwn: !!event.isOwn
  });
  if (chat.length > GROUP_CACHE_MAX_CHAT) chat.splice(0, chat.length - GROUP_CACHE_MAX_CHAT);
  scheduleGroupCacheSave();
}

function buildOwnGroupPresenceEvent(groupId) {
  if (!groupConfig.userId) return null;
  const roomPosition = groupRoomPositions.get(sanitizeGroupId(groupId));
  return buildGroupEvent('group-presence', groupId, {
    from: {
      id: groupConfig.userId,
      catName: groupConfig.catName,
      appearance: sanitizeAppearance(groupConfig.appearance)
    },
    catState: groupConfig.catState || 'awake',
    catSleeping: !!groupConfig.catSleeping,
    sentAt: new Date().toISOString(),
    ...(roomPosition ? { roomX: roomPosition.x, roomY: roomPosition.y } : {})
  }, true);
}

function getGroupSnapshot(groupId) {
  loadGroupCacheOnce();
  const id = sanitizeGroupId(groupId);
  if (!id || !groupConfig.groups.some(group => group.id === id)) {
    return { ok: false, error: 'Group not found.' };
  }

  const ownEvent = buildOwnGroupPresenceEvent(id);
  if (ownEvent) storeGroupPresenceEvent(ownEvent);

  const members = Array.from(getGroupPresence(id).values()).map(member => ({
    ...member,
    isOwn: !!groupConfig.userId && member.userId === groupConfig.userId
  }));
  const messages = getGroupChat(id).map(message => ({
    ...message,
    isOwn: !!groupConfig.userId && message.userId === groupConfig.userId
  }));
  return {
    ok: true,
    groupId: id,
    members,
    messages,
    now: Date.now()
  };
}

function broadcastGroupEvent(payload) {
  try {
    mainWindow?.webContents.send('group-event', payload);
  } catch { /* main window closed */ }
  try {
    if (roomWindow && !roomWindow.isDestroyed() && currentRoomContext.groupId === payload?.groupId) {
      roomWindow.webContents.send('group-event', payload);
    }
  } catch { /* room window closed */ }
}

function groupMessageSeenKey(groupId, id) {
  const safeGroupId = sanitizeGroupId(groupId);
  const safeId = sanitizeMessageId(id);
  return safeGroupId && safeId ? `${safeGroupId}:${safeId}` : '';
}

function rememberGroupMessageId(groupId, id) {
  const key = groupMessageSeenKey(groupId, id);
  if (!key) return;
  groupSeenMessageIds.add(key);
  if (groupSeenMessageIds.size <= 500) return;
  const oldest = groupSeenMessageIds.values().next().value;
  groupSeenMessageIds.delete(oldest);
}

function hasSeenGroupMessageId(groupId, id) {
  const key = groupMessageSeenKey(groupId, id);
  return !!key && groupSeenMessageIds.has(key);
}

function dispatchGroupPayload(groupId, payload) {
  loadGroupCacheOnce();
  if (!payload || typeof payload !== 'object') return;
  const kind = String(payload.kind || '').slice(0, 40);
  const rawFrom = payload.from || {};
  const fromId = sanitizeMessageId(rawFrom.id || payload.fromId);
  if (!fromId) return;
  const isOwn = !!groupConfig.userId && fromId === groupConfig.userId;
  const safeFrom = {
    id: fromId,
    catName: sanitizeText(rawFrom.catName || 'Mochi', PET_MESSAGE_MAX_NAME) || 'Mochi',
    appearance: sanitizeAppearance(rawFrom.appearance)
  };

  if (kind === 'group-presence') {
    const roomX = Number(payload.roomX);
    const roomY = Number(payload.roomY);
    const event = buildGroupEvent('group-presence', groupId, {
      from: safeFrom,
      catState: sanitizeText(payload.catState || payload.state, 24) || 'awake',
      catSleeping: typeof payload.catSleeping === 'boolean' ? payload.catSleeping : !!payload.sleeping,
      sentAt: sanitizeText(payload.sentAt, 40) || new Date().toISOString(),
      ...(Number.isFinite(roomX) && Number.isFinite(roomY) ? { roomX, roomY } : {})
    }, isOwn);
    storeGroupPresenceEvent(event);
    broadcastGroupEvent(event);
    return;
  }

  if (kind === 'group-chat') {
    const id = sanitizeMessageId(payload.id);
    if (id && hasSeenGroupMessageId(groupId, id)) return;
    if (id) rememberGroupMessageId(groupId, id);
    const text = sanitizeText(payload.text, GROUP_MESSAGE_MAX_TEXT);
    if (!text) return;
    const event = buildGroupEvent('group-chat', groupId, {
      id: id || makePetMessageId(),
      from: safeFrom,
      text,
      sentAt: sanitizeText(payload.sentAt, 40) || new Date().toISOString()
    }, isOwn);
    storeGroupChatEvent(event);
    broadcastGroupEvent(event);
  }
}

function handleGroupStreamLine(groupId, line) {
  if (!line) return;
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (!event || event.event === 'open') return;
  if (event.event !== 'message' || !event.message) return;
  let payload;
  try { payload = JSON.parse(event.message); } catch { return; }
  dispatchGroupPayload(groupId, payload);
}

async function startGroupStream(groupId) {
  stopGroupStream(groupId);
  if (petMessageRelayKind() !== 'ntfy') return; // v1: only ntfy-style relays
  const url = groupTopicUrl(groupId, '/json');
  if (!url) return;
  url.searchParams.set('since', PET_MESSAGE_NTFY_CATCHUP);

  const controller = new AbortController();
  const entry = { controller, restartTimer: null };
  groupStreams.set(groupId, entry);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Relay responded with ${response.status}`);
    if (!response.body?.getReader) throw new Error('Relay stream is not available');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!controller.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) handleGroupStreamLine(groupId, line);
    }
  } catch { /* network error / abort — reconnect below */ }
  finally {
    const current = groupStreams.get(groupId);
    const stillJoined = groupConfig.groups.some(g => g.id === groupId);
    if (current === entry && !controller.signal.aborted && stillJoined) {
      entry.restartTimer = setTimeout(() => startGroupStream(groupId), 4000);
    } else if (current === entry) {
      groupStreams.delete(groupId);
    }
  }
}

function stopGroupStream(groupId) {
  const entry = groupStreams.get(groupId);
  if (!entry) return;
  try { entry.controller.abort(); } catch {}
  if (entry.restartTimer) { clearTimeout(entry.restartTimer); entry.restartTimer = null; }
  groupStreams.delete(groupId);
}

function stopAllGroupStreams() {
  for (const id of Array.from(groupStreams.keys())) stopGroupStream(id);
}

async function publishGroupPayload(groupId, body) {
  if (!petMessageConfig.relayUrl || petMessageRelayKind() !== 'ntfy') return false;
  const url = groupTopicUrl(groupId);
  if (!url) return false;
  try {
    await fetchPetMessageText(url, {
      method: 'POST',
      headers: {
        title: String(body.from?.catName || 'Mochi').slice(0, 64),
        tags: 'cat'
      },
      body: JSON.stringify(body)
    });
    return true;
  } catch {
    return false;
  }
}

function buildGroupPresenceBody(groupId) {
  const roomPosition = groupRoomPositions.get(sanitizeGroupId(groupId));
  return {
    kind: 'group-presence',
    groupId,
    from: {
      id: groupConfig.userId,
      catName: groupConfig.catName,
      appearance: sanitizeAppearance(groupConfig.appearance)
    },
    catState: groupConfig.catState || 'awake',
    catSleeping: !!groupConfig.catSleeping,
    state: groupConfig.catState || 'awake',
    sleeping: !!groupConfig.catSleeping,
    sentAt: new Date().toISOString(),
    ...(roomPosition ? { roomX: roomPosition.x, roomY: roomPosition.y } : {})
  };
}

async function sendGroupHeartbeat(groupId) {
  if (!groupConfig.userId) return;
  if (!groupConfig.groups.some(g => g.id === groupId)) return;
  await publishGroupPayload(groupId, buildGroupPresenceBody(groupId));
}

function pulseGroupHeartbeats() {
  if (!groupConfig.userId) return;
  for (const group of groupConfig.groups) {
    sendGroupHeartbeat(group.id);
  }
}

function startGroupHeartbeats() {
  stopGroupHeartbeats();
  if (!groupConfig.userId || groupConfig.groups.length === 0) return;
  // Fire an immediate beat so new members see us quickly, then periodic.
  pulseGroupHeartbeats();
  groupHeartbeatTimer = setInterval(pulseGroupHeartbeats, GROUP_HEARTBEAT_INTERVAL_MS);
}

function stopGroupHeartbeats() {
  if (groupHeartbeatTimer) {
    clearInterval(groupHeartbeatTimer);
    groupHeartbeatTimer = null;
  }
}

function restartAllGroupStreams() {
  const ids = groupConfig.groups.map(g => g.id);
  for (const id of Array.from(groupStreams.keys())) {
    if (!ids.includes(id)) stopGroupStream(id);
  }
  for (const id of ids) {
    stopGroupStream(id);
    startGroupStream(id);
  }
}

function setFollowMouseEnabled(enabled) {
  const wasEnabled = followMouse;
  if (enabled === wasEnabled) {
    broadcastFollowState();
    updateTrayMenu();
    return;
  }

  if (enabled) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      followOriginPosition = mainWindow.getPosition();
    }
    // Align only when entering follow mode to avoid stop-follow flashes.
    alignWindowForFollowModeToggle(true);
  }

  followMouse = enabled;
  if (enabled) {
    startFollowMouse();
    try {
      globalShortcut.unregister('Escape');
      globalShortcut.register('Escape', () => {
        setFollowMouseEnabled(false);
      });
    } catch {}
  } else {
    stopFollowMouse();
    try { globalShortcut.unregister('Escape'); } catch {}
    if (followOriginPosition && mainWindow && !mainWindow.isDestroyed()) {
      const [originX, originY] = followOriginPosition;
      setTimeout(() => {
        if (!followMouse && mainWindow && !mainWindow.isDestroyed() && isSafeWindowCoord(originX) && isSafeWindowCoord(originY)) {
          mainWindow.setPosition(originX, originY);
        }
      }, 16);
    }
    followOriginPosition = null;
  }
  broadcastFollowState();
  updateTrayMenu();
}

ipcMain.on('toggle-follow', (_, enabled) => {
  setFollowMouseEnabled(enabled);
});

ipcMain.handle('configure-pet-messages', (_, config) => {
  const nextConfig = sanitizePetMessageConfig(config);
  const nextInboxKey = petMessageInboxKeyForConfig(nextConfig);
  const inboxChanged = nextInboxKey !== petMessageInboxKey;
  const prevRelayUrl = petMessageConfig.relayUrl;
  petMessageConfig = nextConfig;
  petMessageInboxKey = nextInboxKey;
  if (inboxChanged) {
    petMessageLastPollAt = 0;
    seenPetMessageIds.clear();
  }
  startPetMessagePolling();
  // Group streams ride on the same relay — if it moved, restart them.
  if (prevRelayUrl !== nextConfig.relayUrl && groupConfig.groups.length > 0) {
    groupSeenMessageIds.clear();
    restartAllGroupStreams();
  }
  return {
    ok: true,
    relayEnabled: Boolean(petMessageConfig.relayUrl),
    relayKind: petMessageRelayKind(),
    relayUrl: petMessageConfig.relayUrl,
    userId: petMessageConfig.userId
  };
});

ipcMain.handle('send-pet-message', (_, payload) => sendPetMessage(payload));

ipcMain.handle('configure-groups', (_, config) => {
  loadGroupCacheOnce();
  const rawGroups = Array.isArray(config?.groups) ? config.groups : [];
  const nextGroups = [];
  const seen = new Set();
  for (const raw of rawGroups) {
    const id = sanitizeGroupId(raw?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    nextGroups.push({
      id,
      name: sanitizeText(raw?.name, GROUP_NAME_MAX) || 'Group'
    });
  }

  const userId = sanitizeMessageId(config?.userId) || groupConfig.userId || null;
  const catName = sanitizeText(config?.catName || 'Mochi', PET_MESSAGE_MAX_NAME) || 'Mochi';
  const appearance = sanitizeAppearance(config?.appearance);
  const catState = sanitizeText(config?.catState, 24) || groupConfig.catState || 'awake';
  const catSleeping = typeof config?.catSleeping === 'boolean'
    ? config.catSleeping
    : groupConfig.catSleeping;

  const prevGroupIds = new Set(groupConfig.groups.map(g => g.id));
  groupConfig = {
    groups: nextGroups,
    userId,
    catName,
    appearance,
    catState,
    catSleeping
  };

  // Stop streams for groups we left
  for (const id of Array.from(groupStreams.keys())) {
    if (!seen.has(id)) stopGroupStream(id);
  }
  // Start streams for new groups
  for (const g of nextGroups) {
    if (!prevGroupIds.has(g.id) || !groupStreams.has(g.id)) {
      stopGroupStream(g.id);
      startGroupStream(g.id);
    }
  }

  if (nextGroups.length > 0 && userId) startGroupHeartbeats();
  else stopGroupHeartbeats();

  if (userId) {
    for (const group of nextGroups) {
      const ownEvent = buildOwnGroupPresenceEvent(group.id);
      if (ownEvent) storeGroupPresenceEvent(ownEvent);
    }
  }

  return { ok: true, groups: nextGroups };
});

ipcMain.handle('send-group-message', async (_, payload) => {
  loadGroupCacheOnce();
  const groupId = sanitizeGroupId(payload?.groupId);
  const text = sanitizeText(payload?.text, GROUP_MESSAGE_MAX_TEXT);
  if (!groupId || !groupConfig.groups.some(g => g.id === groupId)) {
    return { ok: false, error: 'Group not found.' };
  }
  if (!text) return { ok: false, error: 'Write a message first.' };
  if (!groupConfig.userId) return { ok: false, error: 'Profile not ready.' };
  if (petMessageRelayKind() !== 'ntfy') {
    return { ok: false, error: 'Groups need an ntfy relay.' };
  }
  const body = {
    kind: 'group-chat',
    groupId,
    id: makePetMessageId(),
    from: {
      id: groupConfig.userId,
      catName: groupConfig.catName,
      appearance: sanitizeAppearance(groupConfig.appearance)
    },
    text,
    sentAt: new Date().toISOString()
  };
  const ok = await publishGroupPayload(groupId, body);
  if (!ok) return { ok: false, error: 'Could not reach the relay — try again.' };
  // Remember own id so stream echo doesn't re-deliver
  rememberGroupMessageId(groupId, body.id);
  const event = buildGroupEvent('group-chat', groupId, {
    id: body.id,
    from: body.from,
    text: body.text,
    sentAt: body.sentAt
  }, true);
  storeGroupChatEvent(event);
  return { ok: true, id: body.id, sentAt: body.sentAt, event };
});

ipcMain.handle('get-group-snapshot', (_, groupId) => getGroupSnapshot(groupId));

ipcMain.on('update-group-room-presence', (_, payload = {}) => {
  const groupId = sanitizeGroupId(payload.groupId);
  const x = Number(payload.x);
  const y = Number(payload.y);
  if (!groupId || !Number.isFinite(x) || !Number.isFinite(y)) return;
  groupRoomPositions.set(groupId, {
    x: Math.max(0, Math.min(448, x)),
    y: Math.max(0, Math.min(448, y)),
    updatedAt: Date.now()
  });
});

ipcMain.on('update-cat-state', (_, state = {}) => {
  if (typeof state.catState === 'string') {
    groupConfig.catState = state.catState.slice(0, 24) || 'awake';
  }
  if (typeof state.catSleeping === 'boolean') {
    groupConfig.catSleeping = state.catSleeping;
  }
  const ownGroupIds = groupConfig.groups.map(group => group.id);
  for (const groupId of ownGroupIds) {
    const ownEvent = buildOwnGroupPresenceEvent(groupId);
    if (ownEvent) {
      storeGroupPresenceEvent(ownEvent);
      broadcastGroupEvent(ownEvent);
    }
  }
  pulseGroupHeartbeats();
});

ipcMain.on('open-room', (_, mode) => createRoomWindow(mode));
ipcMain.on('open-group-room', (_, payload = {}) => {
  const groupId = sanitizeGroupId(payload.groupId);
  if (!groupId) return;
  const groupName = payload.groupName
    ? sanitizeText(payload.groupName, GROUP_NAME_MAX) || 'Group'
    : 'Group';
  createRoomWindow('play', { groupId, groupName });
});
ipcMain.on('close-room', () => {
  if (roomWindow && !roomWindow.isDestroyed()) roomWindow.close();
});
ipcMain.on('quit-app', () => app.quit());
ipcMain.on('hide-mochi', () => hideMochi());
ipcMain.on('install-update-now', () => installUpdateNow());
ipcMain.on('notify', (_, { title, body }) => {
  if (Notification.isSupported()) new Notification({ title, body, silent: false }).show();
});

app.on('before-quit', () => {
  stopPetMessagePolling();
  stopAllGroupStreams();
  stopGroupHeartbeats();
  if (groupCacheSaveTimer) { clearTimeout(groupCacheSaveTimer); groupCacheSaveTimer = null; }
  saveGroupCacheNow();
  if (updateCheckTimer) { clearInterval(updateCheckTimer); updateCheckTimer = null; }
  macUpdater?.installOnQuit();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault());
