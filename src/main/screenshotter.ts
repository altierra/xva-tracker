import { desktopCapturer, shell } from "electron";

let screenshotInterval: ReturnType<typeof setInterval> | null = null;
let _entryId = "";
let _token = "";
let _portalUrl = "";

/**
 * Probe whether Screen Recording is actually working by attempting a real capture
 * via desktopCapturer (Electron main process). This is the only reliable method
 * with ad-hoc signed apps because:
 *  - systemPreferences.getMediaAccessStatus("screen") always returns "not-determined"
 *  - screencapture CLI subprocess has its own TCC entry and doesn't inherit the app's permission
 *  - desktopCapturer runs in-process and correctly gets the granted permission
 *
 * Returns true if a non-black thumbnail was obtained (i.e., permission is working).
 */
export async function probeScreenRecordingGranted(): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 320, height: 180 },
    });
    if (sources.length > 0) {
      const jpeg = sources[0].thumbnail.toJPEG(75);
      return jpeg.length > 500; // real screen content is always >500B at 320×180
    }
  } catch { /* permission denied or unavailable */ }
  return false;
}

/**
 * Open System Settings to the Screen Recording pane.
 */
export function openScreenRecordingSettings() {
  shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
}

/**
 * Capture the screen via desktopCapturer (requires Screen Recording permission).
 */
async function captureScreenBase64(): Promise<string | null> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1280, height: 720 },
    });
    if (sources.length > 0) {
      const jpeg = sources[0].thumbnail.toJPEG(75);
      if (jpeg.length > 1000) {
        return "data:image/jpeg;base64," + jpeg.toString("base64");
      }
    }
  } catch { /* permission denied */ }
  return null;
}

async function takeScreenshot() {
  if (!_entryId || !_token) return;
  try {
    const imageBase64 = await captureScreenBase64();
    if (!imageBase64) return; // permission not granted or capture failed

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
    console.log("[screenshotter] Screenshot captured and uploaded");
  } catch (e) {
    console.error("[screenshotter] Upload failed:", e);
  }
}

export function startScreenshotter(entryId: string, token: string, portalUrl: string, intervalMins: number) {
  _entryId = entryId;
  _token = token;
  _portalUrl = portalUrl;

  const ms = Math.max(1, intervalMins) * 60 * 1000;
  screenshotInterval = setInterval(takeScreenshot, ms);
  // Don't take immediate screenshot — wait the full interval
}

export function stopScreenshotter() {
  if (screenshotInterval) {
    clearInterval(screenshotInterval);
    screenshotInterval = null;
  }
  _entryId = "";
}
