const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, Notification, globalShortcut } = require('electron');
const { autoUpdater } = require('electron-updater');
const { createMacUpdater } = require('./mac-updater');
const path = require('path');

let mainWindow;
let roomWindow;
let tray;
let mochiHidden = false;
let macUpdater;
let windowsUpdateState = { status: 'idle', version: null };

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

ipcMain.on('open-room', (_, mode) => createRoomWindow(mode));
ipcMain.on('quit-app', () => app.quit());
ipcMain.on('hide-mochi', () => hideMochi());
ipcMain.on('install-update-now', () => installUpdateNow());
ipcMain.on('notify', (_, { title, body }) => {
  if (Notification.isSupported()) new Notification({ title, body, silent: false }).show();
});

app.on('before-quit', () => {
  macUpdater?.installOnQuit();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault());
