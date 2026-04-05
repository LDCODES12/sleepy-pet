const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, Notification, globalShortcut } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

let mainWindow;
let roomWindow;
let tray;
let mochiHidden = false;

// Window large enough for room view (340x440) but starts showing only the cat
const WIN_W = 340;
const WIN_H = 440;

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  createWindow();
  createTray();

  // Auto-update from GitHub releases (token injected by CI for private repo)
  const updateToken = '__UPDATE_TOKEN__';
  if (updateToken && !updateToken.startsWith('__')) process.env.GH_TOKEN = updateToken;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
});

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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: mochiHidden ? 'Show Mochi' : 'Hide Mochi', click: () => {
      if (mochiHidden) { showMochi(); }
      else { hideMochi(); }
    }},
    { label: followMouse ? 'Stop Following' : 'Follow Mouse', click: () => {
      followMouse = !followMouse;
      if (followMouse) startFollowMouse(); else { stopFollowMouse(); resetPosition(); }
      mainWindow?.webContents.send('stop-follow');
      updateTrayMenu();
    }},
    { label: 'Reset Position', click: resetPosition },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
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

function createRoomWindow() {
  if (roomWindow) { roomWindow.focus(); return; }

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

  roomWindow.loadFile('room.html');
  roomWindow.on('closed', () => { roomWindow = null; });
}

// Follow-mouse feature
let followMouse = false;
let followInterval = null;

function startFollowMouse() {
  if (followInterval) return;
  followInterval = setInterval(() => {
    if (!mainWindow || !followMouse) return;
    const cursor = screen.getCursorScreenPoint();
    const [wx, wy] = mainWindow.getPosition();
    // Cat sprite: bottom:4 right:4, 64x64 in a 340x440 window
    // Face is on the LEFT side by default; flipped = face on RIGHT
    const catCenterX = wx + WIN_W - 36; // center of 64px sprite
    const facingLeft = cursor.x < catCenterX;
    // Offset so cursor lands a little in front of the face
    const targetX = facingLeft
      ? cursor.x - WIN_W + 72   // face is on left → push window right so face meets cursor
      : cursor.x - WIN_W + 4;   // face is on right → pull window left so face meets cursor
    const targetY = cursor.y - WIN_H + 48;
    const newX = Math.round(wx + (targetX - wx) * 0.08);
    const newY = Math.round(wy + (targetY - wy) * 0.08);
    if (newX !== wx || newY !== wy) {
      mainWindow.setPosition(newX, newY);
    }
    mainWindow.webContents.send('cursor-dir', facingLeft ? 'left' : 'right');
  }, 16);
}

function stopFollowMouse() {
  if (followInterval) { clearInterval(followInterval); followInterval = null; }
}

ipcMain.on('toggle-follow', (_, enabled) => {
  followMouse = enabled;
  if (enabled) {
    startFollowMouse();
    // Register Escape to stop following
    try { globalShortcut.register('Escape', () => {
      followMouse = false;
      stopFollowMouse();
      resetPosition();
      mainWindow?.webContents.send('stop-follow');
      updateTrayMenu();
      globalShortcut.unregister('Escape');
    }); } catch {}
  } else {
    stopFollowMouse();
    try { globalShortcut.unregister('Escape'); } catch {}
  }
  updateTrayMenu();
});

ipcMain.on('open-room', () => createRoomWindow());
ipcMain.on('quit-app', () => app.quit());
ipcMain.on('hide-mochi', () => hideMochi());
ipcMain.on('notify', (_, { title, body }) => {
  if (Notification.isSupported()) new Notification({ title, body, silent: false }).show();
});

app.on('window-all-closed', (e) => e.preventDefault());
