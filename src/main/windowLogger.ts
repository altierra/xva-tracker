import activeWin from "active-win";

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
