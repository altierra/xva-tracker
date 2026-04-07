import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, powerMonitor, shell, dialog, screen } from "electron";
import { autoUpdater } from "electron-updater";
import Store from "electron-store";
import path from "path";
import { startWindowLogger, stopWindowLogger, getActivitySummary, getWindowLog } from "./windowLogger";
import { startScreenshotter, stopScreenshotter } from "./screenshotter";
import { startHeartbeat, stopHeartbeat } from "./heartbeat";

// ── Persistent store ───────────────────────────────────────────────────────────
interface StoreSchema {
  token: string;
  portalUrl: string;
  idleThresholdMins: number;
}

export const store = new Store<StoreSchema>({
  defaults: {
    token: "",
    portalUrl: "https://altierraxva.com",
    idleThresholdMins: 10,
  },
});

// ── Globals ────────────────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isTracking = false;
let currentEntryId: string | null = null;
let idleAlerted = false;
let isQuitting = false;

// ── Jiggler / suspicious-mouse detection ──────────────────────────────────────
interface MouseSample { x: number; y: number; t: number }

const JIGGLER_SAMPLE_MS       = 500;   // poll interval
const JIGGLER_WINDOW_SAMPLES  = 60;    // samples per analysis window (= 30 s)
const JIGGLER_SUSPICIOUS_WINS = 10;    // consecutive suspicious windows needed (= 5 min)
const JIGGLER_DIST_THRESHOLD  = 20;    // px — avg distance between sorted clouds

let mouseSamples: MouseSample[] = [];
let jigglerInterval: ReturnType<typeof setInterval> | null = null;
let suspiciousWindowCount = 0;
let suspiciousAlerted = false;

/** Compare two 30-s position clouds by sorting both and measuring avg point distance.
 *  Low score → same set of coords visited twice → repetitive movement. */
function comparePositionClouds(a: MouseSample[], b: MouseSample[]): number {
  const sortFn = (p: MouseSample, q: MouseSample) => p.x !== q.x ? p.x - q.x : p.y - q.y;
  const sa = [...a].sort(sortFn);
  const sb = [...b].sort(sortFn);
  const len = Math.min(sa.length, sb.length);
  if (len === 0) return 999;
  let total = 0;
  for (let i = 0; i < len; i++) total += Math.hypot(sa[i].x - sb[i].x, sa[i].y - sb[i].y);
  return total / len;
}

function startJigglerDetector() {
  if (jigglerInterval) return;
  mouseSamples = [];
  suspiciousWindowCount = 0;
  suspiciousAlerted = false;

  jigglerInterval = setInterval(() => {
    if (!isTracking || suspiciousAlerted || idleAlerted) return;

    const { x, y } = screen.getCursorScreenPoint();
    mouseSamples.push({ x, y, t: Date.now() });

    // Only analyse once we have 2 full windows
    if (mouseSamples.length < JIGGLER_WINDOW_SAMPLES * 2) return;

    // Analyse at every window boundary
    if (mouseSamples.length % JIGGLER_WINDOW_SAMPLES !== 0) return;

    const total = mouseSamples.length;
    const prev  = mouseSamples.slice(total - JIGGLER_WINDOW_SAMPLES * 2, total - JIGGLER_WINDOW_SAMPLES);
    const curr  = mouseSamples.slice(total - JIGGLER_WINDOW_SAMPLES);

    // If cursor didn't move at all → idle (handled by idle detector), not jiggler
    const allSame = curr.every(s => s.x === curr[0].x && s.y === curr[0].y);
    if (allSame) { suspiciousWindowCount = 0; return; }

    const avgDist = comparePositionClouds(prev, curr);
    if (avgDist < JIGGLER_DIST_THRESHOLD) {
      suspiciousWindowCount++;
    } else {
      suspiciousWindowCount = 0;
    }

    if (suspiciousWindowCount >= JIGGLER_SUSPICIOUS_WINS) {
      suspiciousAlerted = true;
      mainWindow?.webContents.send("suspicious-activity");
    }

    // Trim memory: keep last 20 windows
    if (mouseSamples.length > JIGGLER_WINDOW_SAMPLES * 20) {
      mouseSamples = mouseSamples.slice(-JIGGLER_WINDOW_SAMPLES * 10);
    }
  }, JIGGLER_SAMPLE_MS);
}

function stopJigglerDetector() {
  if (jigglerInterval) { clearInterval(jigglerInterval); jigglerInterval = null; }
  mouseSamples = [];
  suspiciousWindowCount = 0;
  suspiciousAlerted = false;
}

// ── Single instance lock ───────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ── Window creation ────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 600,
    minWidth: 380,
    minHeight: 500,
    title: "XVA Tracker",
    backgroundColor: "#0d0f14",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    frame: process.platform !== "darwin",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  // Load renderer
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));

  mainWindow.once("ready-to-show", () => {
    mainWindow!.show();
  });

  // Red X quits the app
  mainWindow.on("close", () => {
    isQuitting = true;
    app.quit();
  });
}

// ── Tray ───────────────────────────────────────────────────────────────────────
function createTray() {
  // Use template image on macOS for dark/light mode support
  const iconPath = path.join(__dirname, "../../assets/tray-icon.png");
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHklEQVQ4jWNgYGD4z8BQDwAAAP//AwBY3QFTAAAAASUVORK5CYII=") : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("XVA Tracker");
  updateTrayMenu();

  tray.on("click", () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });
}

export function updateTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: isTracking ? "● Tracking…" : "○ Not tracking",
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Open XVA Tracker",
      click: () => { mainWindow?.show(); mainWindow?.focus(); },
    },
    {
      label: "Open Portal",
      click: () => shell.openExternal(store.get("portalUrl") + "/dashboard/va/timetracker"),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.setTitle(isTracking ? "●" : "");
}

// ── Idle monitoring ────────────────────────────────────────────────────────────
let idleInterval: ReturnType<typeof setInterval> | null = null;

function startIdleMonitor() {
  if (idleInterval) return;
  idleInterval = setInterval(() => {
    if (!isTracking) return;
    const idleSecs = powerMonitor.getSystemIdleTime();
    const thresholdSecs = (store.get("idleThresholdMins") as number) * 60;
    if (idleSecs >= thresholdSecs && !idleAlerted) {
      idleAlerted = true;
      mainWindow?.webContents.send("idle-detected", { idleSecs });
    }
    // Send idle status to renderer every tick
    mainWindow?.webContents.send("idle-status", { idleSecs, isIdle: idleSecs >= thresholdSecs });
  }, 5000);
}

function stopIdleMonitor() {
  if (idleInterval) {
    clearInterval(idleInterval);
    idleInterval = null;
  }
}

// ── IPC handlers ───────────────────────────────────────────────────────────────

// Token management
ipcMain.handle("get-token", () => store.get("token"));
ipcMain.handle("set-token", (_e, token: string) => {
  store.set("token", token);
  // Notify renderer of new state
  mainWindow?.webContents.send("auth-changed");
});
ipcMain.handle("clear-token", () => {
  store.set("token", "");
  mainWindow?.webContents.send("auth-changed");
});
ipcMain.handle("get-portal-url", () => store.get("portalUrl"));
ipcMain.handle("set-portal-url", (_e, url: string) => store.set("portalUrl", url));

// Tracking control
ipcMain.handle("start-tracking", async (_e, { entryId, projectConfig }: { entryId: string; projectConfig: ProjectConfig }) => {
  isTracking = true;
  currentEntryId = entryId;
  idleAlerted = false;

  startWindowLogger(entryId, store.get("token") as string, store.get("portalUrl") as string);
  startHeartbeat(entryId, store.get("token") as string, store.get("portalUrl") as string);

  if (projectConfig.screenshotEnabled) {
    startScreenshotter(entryId, store.get("token") as string, store.get("portalUrl") as string, projectConfig.screenshotIntervalMins);
  }

  startIdleMonitor();
  startJigglerDetector();
  updateTrayMenu();
  return { ok: true };
});

ipcMain.handle("stop-tracking", async () => {
  isTracking = false;
  currentEntryId = null;
  idleAlerted = false;

  stopWindowLogger();
  stopHeartbeat();
  stopScreenshotter();
  stopIdleMonitor();
  stopJigglerDetector();
  updateTrayMenu();
  return { ok: true };
});

ipcMain.handle("resume-from-idle", () => {
  idleAlerted = false;
  mainWindow?.webContents.send("idle-resumed");
});

ipcMain.handle("resume-from-suspicious", () => {
  suspiciousAlerted = false;
  suspiciousWindowCount = 0;
  mouseSamples = [];
});

ipcMain.handle("get-tracking-state", () => ({
  isTracking,
  currentEntryId,
  idleThresholdMins: store.get("idleThresholdMins"),
}));

// Config
ipcMain.handle("fetch-config", async () => {
  const token = store.get("token") as string;
  const portalUrl = store.get("portalUrl") as string;
  if (!token) return { ok: false, error: "No token" };
  try {
    const res = await fetch(`${portalUrl}/api/timetracker/agent/config`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, data };
  } catch (e: unknown) {
    return { ok: false, error: String(e) };
  }
});

// Timer entry API — proxied through main to avoid renderer CORS
ipcMain.handle("create-entry", async (_e, body: Record<string, unknown>) => {
  const token = store.get("token") as string;
  const portalUrl = store.get("portalUrl") as string;
  console.log("[create-entry] portalUrl:", portalUrl, "token:", token?.slice(0, 8));
  const res = await fetch(`${portalUrl}/api/timetracker/entries`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) || `HTTP ${res.status}`);
  return data;
});

ipcMain.handle("patch-entry", async (_e, id: string, body: Record<string, unknown>) => {
  const token = store.get("token") as string;
  const portalUrl = store.get("portalUrl") as string;
  console.log("[patch-entry] id:", id, "portalUrl:", portalUrl, "token:", token?.slice(0, 8));
  const res = await fetch(`${portalUrl}/api/timetracker/entries/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) || `HTTP ${res.status}`);
  return data;
});

// Activity log (summary for in-app display)
ipcMain.handle("get-activity-log", () => getActivitySummary());
// Full window log (detailed, sent to portal on stop)
ipcMain.handle("get-window-log", () => getWindowLog());

// Open external links
ipcMain.handle("open-external", (_e, url: string) => shell.openExternal(url));

// Install the already-downloaded update and restart
ipcMain.handle("install-update", () => {
  isQuitting = true;
  autoUpdater.quitAndInstall();
});

// ── Auto-updater ───────────────────────────────────────────────────────────────
autoUpdater.on("update-downloaded", () => {
  // Notify renderer — banner appears so VA can choose when to restart
  mainWindow?.webContents.send("update-ready");
});

// ── App lifecycle ──────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  console.log("[main] app ready, creating window and tray");
  createWindow();
  createTray();
  console.log("[main] IPC handlers registered");

  if (process.env.NODE_ENV !== "development") {
    autoUpdater.checkForUpdatesAndNotify();
    // Re-check every hour in case the app is left open all day
    setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 60 * 60 * 1000);
  }
});

app.on("window-all-closed", () => {
  // Keep app running in tray on all platforms
});

app.on("activate", () => {
  if (mainWindow === null) createWindow();
  else { mainWindow.show(); mainWindow.focus(); }
});

export interface ProjectConfig {
  screenshotEnabled: boolean;
  screenshotIntervalMins: number;
}
