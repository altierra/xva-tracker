import activeWin from "active-win";
import { systemPreferences } from "electron";

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

async function pollWindow() {
  try {
    // On macOS: check accessibility permission WITHOUT prompting (false = no prompt).
    // If not granted, skip silently — calling activeWin() without permission is what
    // triggers the OS popup every time.
    if (process.platform === "darwin" && !systemPreferences.isTrustedAccessibilityClient(false)) {
      return;
    }
    const win = await activeWin();
    const app = win?.owner?.name ?? "Unknown";
    const title = win?.title ?? "";
    const url = (win as { url?: string })?.url ?? null;

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
    // active-win may throw if permissions not granted
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
