import { desktopCapturer } from "electron";

let screenshotInterval: ReturnType<typeof setInterval> | null = null;
let _entryId = "";
let _token = "";
let _portalUrl = "";

async function takeScreenshot() {
  if (!_entryId || !_token) return;
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1280, height: 720 },
    });

    if (!sources.length) return;
    const screenshot = sources[0].thumbnail;
    const imageBase64 = "data:image/jpeg;base64," + screenshot.toJPEG(75).toString("base64");

    await fetch(`${_portalUrl}/api/timetracker/agent/screenshot`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${_token}`,
      },
      body: JSON.stringify({
        entryId: _entryId,
        imageBase64,
        takenAt: new Date().toISOString(),
      }),
    });
  } catch {
    // desktopCapturer may fail if screen recording permission not granted — silent
  }
}

export function startScreenshotter(entryId: string, token: string, portalUrl: string, intervalMins: number) {
  _entryId = entryId;
  _token = token;
  _portalUrl = portalUrl;

  const ms = Math.max(1, intervalMins) * 60 * 1000;
  screenshotInterval = setInterval(takeScreenshot, ms);
  // Don't take an immediate screenshot — wait the full interval first
}

export function stopScreenshotter() {
  if (screenshotInterval) {
    clearInterval(screenshotInterval);
    screenshotInterval = null;
  }
  _entryId = "";
}
