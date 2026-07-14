const { app, BrowserWindow, Menu, Tray, session, ipcMain, Notification } = require('electron');
const path = require('path');

let mainWindow;
let tray = null;
let isQuitting = false;

function createTray() {
  const iconPath = path.join(__dirname, 'public', 'ascentra_logo.png');
  tray = new Tray(iconPath);
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => mainWindow.show() },
    { label: 'Quit', click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  
  tray.setToolTip('Ascentra Command Center');
  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    mainWindow.show();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 600,
    title: "Ascentra Command Center",
    icon: path.join(__dirname, 'public', 'ascentra_logo.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Remove default menu for a premium, clean standalone app experience
  Menu.setApplicationMenu(null);

  // Load the live website directly so that changes to the web version reflect instantly
  mainWindow.loadURL('https://business-management-hub.britsync.co.uk');

  mainWindow.on('close', function (event) {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });

  mainWindow.on('closed', function () {
    mainWindow = null;
  });

  // Show window in taskbar when minimized
  mainWindow.on('minimize', function (event) {
    event.preventDefault();
    mainWindow.hide();
  });
}

// IPC handler for native notifications (from renderer process)
ipcMain.on('show-notification', (event, { title, body }) => {
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: title || 'Ascentra Command',
      body: body || '',
      icon: path.join(__dirname, 'public', 'ascentra_logo.png'),
      silent: false
    });
    
    notification.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
    
    notification.show();
  }
});

// IPC handler to focus main window (for chat notification clicks)
ipcMain.on('focus-window', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('ready', () => {
  // Automatically grant camera, microphone, and notification permissions
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media', 'audioCapture', 'videoCapture', 'notifications'];
    if (allowedPermissions.includes(permission)) {
      return callback(true);
    }
    callback(false);
  });

  // Also grant push notification subscription permission
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (permission === 'notifications' || permission === 'push') {
      return true;
    }
    return false;
  });

  createWindow();
  createTray();
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    if (isQuitting) {
      app.quit();
    }
  }
});

app.on('activate', function () {
  if (mainWindow === null) {
    createWindow();
  }
});
