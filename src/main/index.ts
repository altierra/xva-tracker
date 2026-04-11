import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, powerMonitor, shell, dialog, screen, systemPreferences } from "electron";
import { autoUpdater } from "electron-updater";
import Store from "electron-store";
import path from "path";
import { execSync } from "child_process";
import { startWindowLogger, stopWindowLogger, getActivitySummary, getWindowLog } from "./windowLogger";
import { probeScreenRecordingGranted, openScreenRecordingSettings } from "./screenshotter";
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

const JIGGLER_SAMPLE_MS        = 500;   // poll interval (ms)
const JIGGLER_WINDOW_SAMPLES   = 60;    // samples per short window (= 30 s)
const JIGGLER_SUSPICIOUS_WINS  = 4;     // consecutive suspicious short-windows needed (≈ 2.5–3 min)
const JIGGLER_SHORT_DENSITY    = 0.95;  // ≥95% of ticks moved in a 30-s window → suspicious
const JIGGLER_LONG_DENSITY     = 0.90;  // ≥90% of ticks moved over 10 min → definite jiggler

let mouseSamples: MouseSample[] = [];
let jigglerInterval: ReturnType<typeof setInterval> | null = null;
let suspiciousWindowCount = 0;
let suspiciousAlerted = false;

/**
 * Movement density — fraction of 500 ms ticks where the cursor actually moved.
 * A jiggler moves on nearly every tick (density → 1.0).
 * A human parks the mouse most of the time (density → 0.1–0.4).
 * This signal is immune to macOS cursor acceleration, circle size, and pattern shape.
 */
function movementDensity(samples: MouseSample[]): number {
  if (samples.length < 2) return 0;
  let moved = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].x !== samples[i - 1].x || samples[i].y !== samples[i - 1].y) moved++;
  }
  return moved / (samples.length - 1);
}

function startJigglerDetector() {
  if (jigglerInterval) return;
  mouseSamples = [];
  suspiciousWindowCount = 0;
  suspiciousAlerted = false;

  // Long-window size: 10 min at 500 ms/sample = 1200 samples
  const LONG_WINDOW = 1200;

  jigglerInterval = setInterval(() => {
    // NOTE: intentionally NOT skipping when idleAlerted — a jiggler defeats
    // idle detection and that's exactly the case we want to catch.
    if (!isTracking || suspiciousAlerted) return;

    const { x, y } = screen.getCursorScreenPoint();
    mouseSamples.push({ x, y, t: Date.now() });

    // ── Long-window check (10 min rolling, triggers immediately) ──────────────
    if (mouseSamples.length >= LONG_WINDOW) {
      const longWindow = mouseSamples.slice(-LONG_WINDOW);
      const longDensity = movementDensity(longWindow);
      console.log(`[jiggler] long-window density=${longDensity.toFixed(3)} (threshold ${JIGGLER_LONG_DENSITY})`);
      if (longDensity >= JIGGLER_LONG_DENSITY) {
        suspiciousAlerted = true;
        surfaceWindow();
        reportOffense("jiggler").then(action => {
          if (action === "warn") {
            mainWindow?.webContents.send("suspicious-activity", { offense: 1 });
          } else {
            handleOffenseResult("jiggler", action);
          }
        });
        return;
      }
    }

    // ── Short-window check (30 s = 60 samples, requires N consecutive wins) ──
    if (mouseSamples.length < JIGGLER_WINDOW_SAMPLES) return;
    if (mouseSamples.length % JIGGLER_WINDOW_SAMPLES !== 0) return;

    const shortWindow = mouseSamples.slice(-JIGGLER_WINDOW_SAMPLES);
    const shortDensity = movementDensity(shortWindow);

    console.log(
      `[jiggler] short-window density=${shortDensity.toFixed(3)}` +
      ` (threshold ${JIGGLER_SHORT_DENSITY})` +
      ` | consecutive=${suspiciousWindowCount} → ${shortDensity >= JIGGLER_SHORT_DENSITY ? "SUSPICIOUS" : "ok"}`
    );

    if (shortDensity >= JIGGLER_SHORT_DENSITY) {
      suspiciousWindowCount++;
    } else {
      suspiciousWindowCount = 0;
    }

    if (suspiciousWindowCount >= JIGGLER_SUSPICIOUS_WINS) {
      suspiciousAlerted = true;
      surfaceWindow();
      reportOffense("jiggler").then(action => {
        if (action === "warn") {
          mainWindow?.webContents.send("suspicious-activity", { offense: 1 });
        } else {
          handleOffenseResult("jiggler", action);
        }
      });
    }

    // Trim memory: keep last 10-min long-window worth of samples
    if (mouseSamples.length > LONG_WINDOW * 2) {
      mouseSamples = mouseSamples.slice(-LONG_WINDOW);
    }
  }, JIGGLER_SAMPLE_MS);
}

function stopJigglerDetector() {
  if (jigglerInterval) { clearInterval(jigglerInterval); jigglerInterval = null; }
  mouseSamples = [];
  suspiciousWindowCount = 0;
  suspiciousAlerted = false;
}

// ── Compliance: offense reporting ─────────────────────────────────────────────
/**
 * Report an idle or jiggler offense to the portal.
 * Returns the action to take: "warn" | "close_day" | "suspend" | "already_closed" | "already_suspended"
 */
async function reportOffense(type: "idle" | "jiggler"): Promise<string> {
  const token     = store.get("token") as string;
  const portalUrl = store.get("portalUrl") as string;
  if (!token || !portalUrl) return "warn";
  try {
    const res = await fetch(`${portalUrl}/api/timetracker/offense`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type }),
    });
    if (!res.ok) return "warn";
    const data = await res.json() as { action?: string };
    return data.action ?? "warn";
  } catch {
    return "warn"; // fail-safe: treat as first warning if portal unreachable
  }
}

/**
 * Forcibly stop the current tracking session from the main process.
 * Notifies the renderer to finalize and save the entry.
 */
async function forceStopTracking() {
  isTracking = false;
  currentEntryId = null;
  idleAlerted = false;
  stopWindowLogger();
  stopHeartbeat();
  stopScreenshotter();
  stopIdleMonitor();
  stopMeetingDetector();
  stopJigglerDetector();
  updateTrayMenu();
  // Tell renderer to finalize (save) the entry
  mainWindow?.webContents.send("force-stop-tracking");
}

/**
 * Handle offense result from portal: fire appropriate event to renderer or stop tracking.
 */
async function handleOffenseResult(type: "idle" | "jiggler", action: string) {
  if (action === "warn") {
    // Already sent the primary event (idle-detected / suspicious-activity) with offense:1
    // Nothing extra to do here
    return;
  }
  if (action === "close_day" || action === "already_closed") {
    // Stop tracking and tell renderer the day is closed
    await forceStopTracking();
    mainWindow?.webContents.send("day-closed", { reason: type });
  } else if (action === "suspend" || action === "already_suspended") {
    await forceStopTracking();
    mainWindow?.webContents.send("tracker-suspended", { reason: type });
  }
}

// ── Accessibility permission (macOS) ──────────────────────────────────────────
/**
 * Returns whether accessibility permission is currently granted.
 * We never call isTrustedAccessibilityClient(true) — that shows an OS-level
 * dialog which can restart the app mid-session and reset tracking state.
 * Instead the renderer shows a non-intrusive banner with a direct Settings link.
 */
function isAccessibilityGranted(): boolean {
  if (process.platform !== "darwin") return true;
  return systemPreferences.isTrustedAccessibilityClient(false);
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

// ── Bring window to foreground ─────────────────────────────────────────────────
/**
 * Surfaces the tracker window above all other apps so the VA sees the alert
 * immediately, regardless of what they're doing on screen.
 */
function surfaceWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  // setAlwaysOnTop briefly puts it above full-screen apps, then releases the pin
  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.focus();
  app.focus({ steal: true });
  // Release always-on-top after 8 s so it doesn't get in the way permanently
  setTimeout(() => mainWindow?.setAlwaysOnTop(false), 8000);
}

// ── Meeting detection ─────────────────────────────────────────────────────────
// Option B — app/window title keywords (VA switched to take notes mid-meeting)
const MEETING_APP_NAMES = [
  "zoom.us", "zoom",
  "microsoft teams", "msteams", "com.microsoft.teams2",
  "webex",
  "facetime",
  "skype",
  "discord",
];
const MEETING_TITLE_KEYWORDS = [
  "zoom meeting",
  "google meet", "meet.google",
  "microsoft teams",
  "webex meeting",
  "whereby",
  "facetime",
  "on a call",
];

// Option C — 15-min grace period after last confirmed meeting signal
const MEETING_GRACE_MS = 15 * 60 * 1000;

let lastMeetingSeenAt = 0;
let meetingDetected   = false;
let meetingPollInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Option C — check if the microphone is actively capturing audio on macOS.
 * IOAudioEngineState = 3 means the audio engine is running (input or output).
 * Using this as the primary signal: if audio is live, assume a call is happening.
 */
function isMicrophoneInUse(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const out = execSync(
      'ioreg -l 2>/dev/null | grep -c \'"IOAudioEngineState" = 3\'',
      { encoding: "utf8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    return parseInt(out, 10) > 0;
  } catch {
    return false;
  }
}

/** Runs every 10 s while tracking — updates meetingDetected flag. */
async function pollMeetingState(): Promise<void> {
  try {
    // Option C: microphone is live
    const micInUse = isMicrophoneInUse();

    // Option B: active window belongs to a known meeting app or URL (via AppleScript)
    let windowIsMeeting = false;
    try {
      const out = execSync(
        `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`,
        { encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }
      ).trim().toLowerCase();
      windowIsMeeting = MEETING_APP_NAMES.some(n => out.includes(n));
    } catch { /* ignore */ }

    if (micInUse || windowIsMeeting) {
      lastMeetingSeenAt = Date.now();
      meetingDetected   = true;
      console.log(`[meeting] active — mic:${micInUse} window:${windowIsMeeting}`);
    } else if (lastMeetingSeenAt > 0 && Date.now() - lastMeetingSeenAt < MEETING_GRACE_MS) {
      meetingDetected = true;
      const minsSince = Math.round((Date.now() - lastMeetingSeenAt) / 60000);
      console.log(`[meeting] grace period — ${minsSince}m since last signal`);
    } else {
      meetingDetected = false;
    }
  } catch {
    meetingDetected = false;
  }
}

function startMeetingDetector() {
  if (meetingPollInterval) return;
  lastMeetingSeenAt = 0;
  meetingDetected   = false;
  pollMeetingState();                                          // immediate first check
  meetingPollInterval = setInterval(pollMeetingState, 10_000);
}

function stopMeetingDetector() {
  if (meetingPollInterval) { clearInterval(meetingPollInterval); meetingPollInterval = null; }
  lastMeetingSeenAt = 0;
  meetingDetected   = false;
}

// ── Idle monitoring ────────────────────────────────────────────────────────────
let idleInterval: ReturnType<typeof setInterval> | null = null;
let activeIdleThresholdMins = store.get("idleThresholdMins") as number;

function startIdleMonitor(idleThresholdMins?: number) {
  if (idleInterval) return;
  if (idleThresholdMins !== undefined) activeIdleThresholdMins = idleThresholdMins;
  idleInterval = setInterval(() => {
    if (!isTracking) return;
    const idleSecs = powerMonitor.getSystemIdleTime();
    const thresholdSecs = activeIdleThresholdMins * 60;
    if (idleSecs >= thresholdSecs && !idleAlerted) {
      if (meetingDetected) {
        console.log("[idle] suppressed — meeting in progress or within grace period");
        return;
      }
      idleAlerted = true;
      surfaceWindow();
      reportOffense("idle").then(action => {
        if (action === "warn") {
          mainWindow?.webContents.send("idle-detected", { idleSecs, offense: 1 });
        } else if (action === "already_closed" || action === "already_suspended") {
          handleOffenseResult("idle", action);
        } else {
          // close_day or suspend — send idle event with offense:2 first so renderer
          // can show the "day closed" banner, then force-stop
          mainWindow?.webContents.send("idle-detected", { idleSecs, offense: 2 });
          handleOffenseResult("idle", action);
        }
      });
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

  startIdleMonitor(projectConfig.idleThresholdMins);
  startMeetingDetector();
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
  stopMeetingDetector();
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

ipcMain.handle("report-offense", async (_e, type: "idle" | "jiggler") => {
  const action = await reportOffense(type);
  await handleOffenseResult(type, action);
  return action;
});

ipcMain.handle("check-suspension", async () => {
  const token     = store.get("token") as string;
  const portalUrl = store.get("portalUrl") as string;
  if (!token || !portalUrl) return { suspended: false };
  try {
    const res = await fetch(`${portalUrl}/api/timetracker/suspension-status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { suspended: false };
    return await res.json();
  } catch {
    return { suspended: false };
  }
});

ipcMain.handle("get-accessibility-granted", () => isAccessibilityGranted());
ipcMain.handle("get-screen-recording-granted", async () => probeScreenRecordingGranted());
ipcMain.handle("open-screen-recording-settings", () => openScreenRecordingSettings());

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
  // Safely parse response — server may return empty body on 500 errors
  let data: Record<string, unknown> = {};
  try {
    const text = await res.text();
    if (text.trim()) data = JSON.parse(text);
  } catch { /* non-JSON response — leave data empty */ }
  if (!res.ok) throw new Error((data.error as string) || `HTTP ${res.status}`);
  return data;
});

// Fetch current usage for a project (for client-side limit enforcement)
ipcMain.handle("fetch-usage", async (_e, projectId: string) => {
  const token = store.get("token") as string;
  const portalUrl = store.get("portalUrl") as string;
  if (!token || !projectId) return null;
  try {
    const res = await fetch(`${portalUrl}/api/timetracker/usage?projectId=${encodeURIComponent(projectId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return await res.json() as { dailySecs: number; weeklySecs: number; monthlySecs: number };
  } catch { return null; }
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

  // Accessibility is checked via IPC — renderer shows a non-intrusive banner

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
  idleThresholdMins: number;
}
