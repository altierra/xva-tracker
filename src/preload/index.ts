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
  startTracking: (entryId: string, projectConfig: { screenshotEnabled: boolean; screenshotIntervalMins: number }) =>
    ipcRenderer.invoke("start-tracking", { entryId, projectConfig }),
  stopTracking: () => ipcRenderer.invoke("stop-tracking"),
  resumeFromIdle: () => ipcRenderer.invoke("resume-from-idle"),
  getTrackingState: () => ipcRenderer.invoke("get-tracking-state"),

  // Timer API (proxied through main process to avoid CORS)
  createEntry: (body: Record<string, unknown>) => ipcRenderer.invoke("create-entry", body),
  patchEntry: (id: string, body: Record<string, unknown>) => ipcRenderer.invoke("patch-entry", id, body),

  // Activity log
  getActivityLog: () => ipcRenderer.invoke("get-activity-log"),

  // Updates
  checkUpdates: () => ipcRenderer.invoke("check-updates"),

  // External links
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),

  // Events from main → renderer
  onIdleDetected: (cb: (payload: { idleSecs: number }) => void) => {
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
  onUpdateAvailable: (cb: () => void) => {
    ipcRenderer.on("update-available", cb);
    return () => ipcRenderer.removeAllListeners("update-available");
  },
});

// Type declaration for renderer
export {};
