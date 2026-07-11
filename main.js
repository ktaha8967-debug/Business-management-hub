const { app, BrowserWindow, Menu, Tray, session } = require('electron');
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
      sandbox: false
    }
  });

  // Remove default menu for a premium, clean standalone app experience
  Menu.setApplicationMenu(null);

  // Load local server in development mode, otherwise load the live website
  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:5000');
  } else {
    mainWindow.loadURL('https://taha.mayfairmarketing.online');
  }

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
}

app.on('ready', () => {
  // Automatically grant camera, microphone, and notification permissions
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media', 'audioCapture', 'videoCapture', 'notifications'];
    if (allowedPermissions.includes(permission)) {
      return callback(true);
    }
    callback(false);
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
