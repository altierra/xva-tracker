import { execSync } from "child_process";

interface WindowEntry {
  app: string;
  title: string;
  url: string | null;
  startedAt: string;
  endedAt: string;
}

let logInterval: ReturnType<typeof setInterval> | null = null;
let currentWindow: { app: string; title: string; url: string | null; startedAt: string } | null = null;
let windowLog: WindowEntry[] = [];
let _entryId: string = "";
let _token: string = "";
let _portalUrl: string = "";

/**
 * Get the active window using AppleScript — no Accessibility or Screen Recording
 * permission needed for basic app name + window title on macOS.
 * Falls back to "Unknown" gracefully if anything fails.
 */
function getActiveWindowMac(): { app: string; title: string; url: string | null } {
  try {
    const script = `
      tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        set winTitle to ""
        try
          set winTitle to name of front window of frontApp
        end try
        return appName & "|||" & winTitle
      end tell
    `;
    const out = execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const [app, title] = out.split("|||");
    return { app: app?.trim() || "Unknown", title: title?.trim() || "", url: null };
  } catch {
    return { app: "Unknown", title: "", url: null };
  }
}

async function pollWindow() {
  try {
    const { app, title, url } = process.platform === "darwin"
      ? getActiveWindowMac()
      : { app: "Unknown", title: "", url: null };

    if (!app || app === "Unknown") return;

    if (!currentWindow) {
      currentWindow = { app, title, url, startedAt: new Date().toISOString() };
      return;
    }

    // If the active window changed, close the previous entry
    if (currentWindow.app !== app || currentWindow.title !== title) {
      windowLog.push({
        app: currentWindow.app,
        title: currentWindow.title,
        url: currentWindow.url,
        startedAt: currentWindow.startedAt,
        endedAt: new Date().toISOString(),
      });
      currentWindow = { app, title, url, startedAt: new Date().toISOString() };
    }
  } catch {
    // fail silently
  }
}

export function startWindowLogger(entryId: string, token: string, portalUrl: string) {
  _entryId = entryId;
  _token = token;
  _portalUrl = portalUrl;
  windowLog = [];
  currentWindow = null;

  // Poll every 10 seconds
  logInterval = setInterval(pollWindow, 10_000);
  pollWindow(); // immediate first poll
}

export function stopWindowLogger() {
  if (logInterval) {
    clearInterval(logInterval);
    logInterval = null;
  }
  // Close any open window entry
  if (currentWindow) {
    windowLog.push({
      ...currentWindow,
      endedAt: new Date().toISOString(),
    });
    currentWindow = null;
  }
}

export function getWindowLog(): WindowEntry[] {
  return [...windowLog];
}

export interface AppUsage {
  app: string;
  durationSecs: number;
}

export function getActivitySummary(): AppUsage[] {
  const entries: WindowEntry[] = [...windowLog];
  // Include current in-progress window
  if (currentWindow) {
    entries.push({ ...currentWindow, endedAt: new Date().toISOString() });
  }

  const map = new Map<string, number>();
  for (const entry of entries) {
    const dur = (new Date(entry.endedAt).getTime() - new Date(entry.startedAt).getTime()) / 1000;
    if (dur > 0) map.set(entry.app, (map.get(entry.app) ?? 0) + dur);
  }

  return Array.from(map.entries())
    .map(([app, durationSecs]) => ({ app, durationSecs: Math.round(durationSecs) }))
    .sort((a, b) => b.durationSecs - a.durationSecs);
}
