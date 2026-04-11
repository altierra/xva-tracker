import { desktopCapturer, systemPreferences, shell } from "electron";
import { execSync } from "child_process";
import { readFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let screenshotInterval: ReturnType<typeof setInterval> | null = null;
let _entryId = "";
let _token = "";
let _portalUrl = "";

/**
 * Check if Screen Recording permission is granted on macOS.
 * Unlike Accessibility, getMediaAccessStatus is reliable for screen recording.
 */
export function isScreenRecordingGranted(): boolean {
  if (process.platform !== "darwin") return true;
  const status = systemPreferences.getMediaAccessStatus("screen");
  return status === "granted";
}

/**
 * Open System Settings to the Screen Recording pane.
 */
export function openScreenRecordingSettings() {
  shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
}

/**
 * Try desktopCapturer first (works when Screen Recording is granted).
 * Falls back to screencapture CLI which also needs Screen Recording but
 * triggers the macOS permission prompt if not yet determined.
 */
async function captureScreenBase64(): Promise<string | null> {
  // Method 1: desktopCapturer (Electron native)
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1280, height: 720 },
    });
    if (sources.length > 0) {
      const jpeg = sources[0].thumbnail.toJPEG(75);
      if (jpeg.length > 1000) { // non-empty image
        return "data:image/jpeg;base64," + jpeg.toString("base64");
      }
    }
  } catch { /* fall through to CLI */ }

  // Method 2: screencapture CLI fallback
  if (process.platform === "darwin") {
    const tmpFile = join(tmpdir(), `xva_ss_${Date.now()}.jpg`);
    try {
      execSync(`screencapture -x -t jpg -m "${tmpFile}"`, {
        timeout: 8000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (existsSync(tmpFile)) {
        const buf = readFileSync(tmpFile);
        unlinkSync(tmpFile);
        if (buf.length > 1000) {
          return "data:image/jpeg;base64," + buf.toString("base64");
        }
      }
    } catch {
      if (existsSync(tmpFile)) { try { unlinkSync(tmpFile); } catch { /* ignore */ } }
    }
  }

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
