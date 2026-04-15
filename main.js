const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, Notification, globalShortcut } = require('electron');
const { autoUpdater } = require('electron-updater');
const { createMacUpdater } = require('./mac-updater');
const path = require('path');

let mainWindow;
let roomWindow;
let tray;
let mochiHidden = false;
let macUpdater;

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
      onStateChange: updateTrayMenu
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

  const macUpdateState = macUpdater?.getState();
  const items = [
    { label: mochiHidden ? 'Show Mochi' : 'Hide Mochi', click: () => {
      if (mochiHidden) { showMochi(); }
      else { hideMochi(); }
    }},
    { label: followMouse ? 'Stop Following' : 'Follow Mouse', click: () => {
      setFollowMouseEnabled(!followMouse, { resetPositionOnStop: true });
    }},
    { label: 'Reset Position', click: resetPosition }
  ];

  if (macUpdateState?.status === 'ready') {
    items.push(
      { type: 'separator' },
      {
        label: `Restart to Update ${macUpdateState.version}`,
        click: () => macUpdater.installNow()
      }
    );
  } else if (macUpdateState?.status === 'downloading') {
    items.push(
      { type: 'separator' },
      { label: `Downloading Update ${macUpdateState.version}`, enabled: false }
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

function clampFollowTarget(x, y) {
  const bounds = getVirtualDisplayBounds();
  const minFaceX = Math.min(CAT_FACE_LEFT_X, CAT_FACE_RIGHT_X);
  const maxFaceX = Math.max(CAT_FACE_LEFT_X, CAT_FACE_RIGHT_X);
  return {
    x: clamp(
      x,
      bounds.x - maxFaceX - FOLLOW_SCREEN_OVERSCAN,
      bounds.x + bounds.width - minFaceX + FOLLOW_SCREEN_OVERSCAN
    ),
    y: clamp(
      y,
      bounds.y - CAT_FACE_Y - FOLLOW_SCREEN_OVERSCAN,
      bounds.y + bounds.height - CAT_FACE_Y + FOLLOW_SCREEN_OVERSCAN
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
      const facingLeft = cursor.x < wx + CAT_CENTER_X;
      const faceX = facingLeft ? CAT_FACE_LEFT_X : CAT_FACE_RIGHT_X;
      const target = clampFollowTarget(cursor.x - faceX, cursor.y - CAT_FACE_Y);
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

function setFollowMouseEnabled(enabled, { resetPositionOnStop = false } = {}) {
  followMouse = enabled;
  if (enabled) {
    startFollowMouse();
    try {
      globalShortcut.unregister('Escape');
      globalShortcut.register('Escape', () => {
        setFollowMouseEnabled(false, { resetPositionOnStop: true });
      });
    } catch {}
  } else {
    stopFollowMouse();
    try { globalShortcut.unregister('Escape'); } catch {}
    if (resetPositionOnStop) resetPosition();
  }
  broadcastFollowState();
  updateTrayMenu();
}

ipcMain.on('toggle-follow', (_, enabled) => {
  setFollowMouseEnabled(enabled, { resetPositionOnStop: !enabled });
});

ipcMain.on('open-room', (_, mode) => createRoomWindow(mode));
ipcMain.on('quit-app', () => app.quit());
ipcMain.on('hide-mochi', () => hideMochi());
ipcMain.on('notify', (_, { title, body }) => {
  if (Notification.isSupported()) new Notification({ title, body, silent: false }).show();
});

app.on('before-quit', () => {
  macUpdater?.installOnQuit();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault());
