const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, Notification, globalShortcut } = require('electron');
const { autoUpdater } = require('electron-updater');
const { createMacUpdater } = require('./mac-updater');
const crypto = require('crypto');
const path = require('path');

let mainWindow;
let roomWindow;
let tray;
let mochiHidden = false;
let macUpdater;
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
const seenPetMessageIds = new Set();

// Window large enough for room view (340x440) but starts showing only the cat
const WIN_W = 340;
const WIN_H = 440;

// Keep these in sync with the visible cat canvas in index.html.
const CAT_STAGE_W = 96;
const CAT_STAGE_H = 80;
const CAT_CANVAS_LEFT = WIN_W + 12 - CAT_STAGE_W; // CSS right:-12px
const CAT_CANVAS_TOP = WIN_H - 4 - CAT_STAGE_H; // CSS bottom:4px
const CAT_CENTER_X = CAT_CANVAS_LEFT + 48;
const CAT_FACE_LEFT_X = CAT_CANVAS_LEFT + 21;
const CAT_FACE_RIGHT_X = CAT_CANVAS_LEFT + 70;
const CAT_FACE_Y = CAT_CANVAS_TOP + 37;
// Follow mode pins the cat canvas to the top-left of the window in renderer,
// so use local canvas coordinates for target math.
const FOLLOW_CAT_CENTER_X = 48;
const FOLLOW_CAT_FACE_LEFT_X = 21;
const FOLLOW_CAT_FACE_RIGHT_X = 70;
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

function setupAutoUpdates() {
  if (process.platform === 'darwin') {
    macUpdater = createMacUpdater({
      app,
      Notification,
      onStateChange: () => {
        updateTrayMenu();
        broadcastUpdateState();
      }
    });
    setTimeout(() => {
      macUpdater.checkForUpdates({ silent: false }).catch(() => {});
    }, 3000);
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

  if (updateState?.status === 'ready') {
    items.push(
      { type: 'separator' },
      {
        label: `Restart to Update ${updateState.version || ''}`.trim(),
        click: installUpdateNow
      }
    );
  } else if (updateState?.status === 'downloading' || updateState?.status === 'checking') {
    items.push(
      { type: 'separator' },
      {
        label: updateState.version
          ? `Downloading Update ${updateState.version}`
          : 'Checking for Update...',
        enabled: false
      }
    );
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

function createRoomWindow(initialMode = 'edit') {
  const mode = initialMode === 'play' ? 'play' : 'edit';
  if (roomWindow) {
    roomWindow.focus();
    roomWindow.webContents.send('set-room-mode', mode);
    return;
  }

  roomWindow = new BrowserWindow({
    width: 900,
    height: 650,
    title: "Mochi's Room",
    resizable: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'room-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  roomWindow.loadFile('room.html', { query: { mode } });
  roomWindow.on('closed', () => { roomWindow = null; });
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
  if (seenPetMessageIds.size <= 200) return;
  const oldest = seenPetMessageIds.values().next().value;
  seenPetMessageIds.delete(oldest);
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
  petMessageConfig = sanitizePetMessageConfig(config);
  petMessageLastPollAt = 0;
  seenPetMessageIds.clear();
  startPetMessagePolling();
  return {
    ok: true,
    relayEnabled: Boolean(petMessageConfig.relayUrl),
    relayKind: petMessageRelayKind(),
    relayUrl: petMessageConfig.relayUrl,
    userId: petMessageConfig.userId
  };
});

ipcMain.handle('send-pet-message', (_, payload) => sendPetMessage(payload));

ipcMain.on('open-room', (_, mode) => createRoomWindow(mode));
ipcMain.on('quit-app', () => app.quit());
ipcMain.on('hide-mochi', () => hideMochi());
ipcMain.on('install-update-now', () => installUpdateNow());
ipcMain.on('notify', (_, { title, body }) => {
  if (Notification.isSupported()) new Notification({ title, body, silent: false }).show();
});

app.on('before-quit', () => {
  stopPetMessagePolling();
  macUpdater?.installOnQuit();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault());
