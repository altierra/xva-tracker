import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("xvaApi", {
  // Token / auth
  getToken: () => ipcRenderer.invoke("get-token"),
  setToken: (token: string) => ipcRenderer.invoke("set-token", token),
  clearToken: () => ipcRenderer.invoke("clear-token"),
  getPortalUrl: () => ipcRenderer.invoke("get-portal-url"),
  setPortalUrl: (url: string) => ipcRenderer.invoke("set-portal-url", url),

  // Config from portal
  fetchConfig: () => ipcRenderer.invoke("fetch-config"),

  // Tracking
  startTracking: (entryId: string, projectConfig: { screenshotEnabled: boolean; screenshotIntervalMins: number; idleThresholdMins: number }) =>
    ipcRenderer.invoke("start-tracking", { entryId, projectConfig }),
  stopTracking: () => ipcRenderer.invoke("stop-tracking"),
  resumeFromIdle: () => ipcRenderer.invoke("resume-from-idle"),
  getTrackingState: () => ipcRenderer.invoke("get-tracking-state"),

  // Timer API (proxied through main process to avoid CORS)
  createEntry: (body: Record<string, unknown>) => ipcRenderer.invoke("create-entry", body),
  patchEntry: (id: string, body: Record<string, unknown>) => ipcRenderer.invoke("patch-entry", id, body),

  // Activity log (summary for in-app panel)
  getActivityLog: () => ipcRenderer.invoke("get-activity-log"),
  // Full window log (sent to portal when timer stops)
  getWindowLog: () => ipcRenderer.invoke("get-window-log"),

  // Platform info
  platform: process.platform,

  // Fetch project usage for client-side limit enforcement
  fetchUsage: (projectId: string) => ipcRenderer.invoke("fetch-usage", projectId),

  // Updates
  installUpdate: () => ipcRenderer.invoke("install-update"),

  // Suspicious activity
  resumeFromSuspicious: () => ipcRenderer.invoke("resume-from-suspicious"),

  // Compliance — offense reporting & suspension status
  reportOffense: (type: "idle" | "jiggler") => ipcRenderer.invoke("report-offense", type),
  checkSuspension: () => ipcRenderer.invoke("check-suspension"),

  // External links
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),

  // Accessibility permission status (macOS) — renderer uses this to show a banner
  getAccessibilityGranted: () => ipcRenderer.invoke("get-accessibility-granted"),

  // Screen Recording permission (macOS) — required for screenshots
  getScreenRecordingGranted: () => ipcRenderer.invoke("get-screen-recording-granted"),
  openScreenRecordingSettings: () => ipcRenderer.invoke("open-screen-recording-settings"),

  // Events from main → renderer
  onIdleDetected: (cb: (payload: { idleSecs: number; offense?: number; closeDay?: boolean }) => void) => {
    ipcRenderer.on("idle-detected", (_e, payload) => cb(payload));
    return () => ipcRenderer.removeAllListeners("idle-detected");
  },
  onIdleStatus: (cb: (payload: { idleSecs: number; isIdle: boolean }) => void) => {
    ipcRenderer.on("idle-status", (_e, payload) => cb(payload));
    return () => ipcRenderer.removeAllListeners("idle-status");
  },
  onIdleResumed: (cb: () => void) => {
    ipcRenderer.on("idle-resumed", cb);
    return () => ipcRenderer.removeAllListeners("idle-resumed");
  },
  onAuthChanged: (cb: () => void) => {
    ipcRenderer.on("auth-changed", cb);
    return () => ipcRenderer.removeAllListeners("auth-changed");
  },
  onUpdateReady: (cb: () => void) => {
    ipcRenderer.on("update-ready", cb);
    return () => ipcRenderer.removeAllListeners("update-ready");
  },
  onSuspiciousActivity: (cb: (payload: { offense?: number }) => void) => {
    ipcRenderer.on("suspicious-activity", (_e, payload) => cb(payload ?? {}));
    return () => ipcRenderer.removeAllListeners("suspicious-activity");
  },
  onDayClosed: (cb: (payload: { reason: "idle" | "jiggler" }) => void) => {
    ipcRenderer.on("day-closed", (_e, payload) => cb(payload));
    return () => ipcRenderer.removeAllListeners("day-closed");
  },
  onTrackerSuspended: (cb: (payload: { reason: "idle" | "jiggler" }) => void) => {
    ipcRenderer.on("tracker-suspended", (_e, payload) => cb(payload));
    return () => ipcRenderer.removeAllListeners("tracker-suspended");
  },
  onForceStop: (cb: () => void) => {
    ipcRenderer.on("force-stop-tracking", cb);
    return () => ipcRenderer.removeAllListeners("force-stop-tracking");
  },
});

// Type declaration for renderer
export {};
