// StepForge demo desktop app — by Md Zarin Tasnim. A tiny Electron "Notes" app used to test StepForge's desktop
// support: a main window with a form, and an About window opened from it (a second window, like a new tab).
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

function aboutWindow() {
  const win = new BrowserWindow({ width: 420, height: 300, title: 'About Notes' });
  win.loadFile(path.join(__dirname, 'about.html'));
}

function mainWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    title: 'Notes',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('open-about', () => aboutWindow());
ipcMain.handle('app-version', () => app.getVersion());

app.whenReady().then(mainWindow);
app.on('window-all-closed', () => app.quit());
