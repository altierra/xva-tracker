export interface Project {
  id: string;
  name: string;
  color: string;
  dailyLimitMins: number | null;
  weeklyLimitMins: number | null;
  monthlyLimitMins: number | null;
  idleThresholdMins: number;
  screenshotEnabled: boolean;
  screenshotIntervalMins: number;
}

export interface RunningEntry {
  id: string;
  projectId: string;
  description: string | null;
  startTime: string;
  project: { name: string; color: string } | null;
}

export interface AgentConfig {
  projects: Project[];
  runningEntry: RunningEntry | null;
}

export interface AppUsage {
  app: string;
  durationSecs: number;
}

export interface XvaApi {
  getToken: () => Promise<string>;
  setToken: (token: string) => Promise<void>;
  clearToken: () => Promise<void>;
  getPortalUrl: () => Promise<string>;
  setPortalUrl: (url: string) => Promise<void>;
  fetchConfig: () => Promise<{ ok: boolean; data?: AgentConfig; error?: string }>;
  startTracking: (entryId: string, projectConfig: { screenshotEnabled: boolean; screenshotIntervalMins: number }) => Promise<{ ok: boolean }>;
  stopTracking: () => Promise<{ ok: boolean }>;
  resumeFromIdle: () => Promise<void>;
  getTrackingState: () => Promise<{ isTracking: boolean; currentEntryId: string | null; idleThresholdMins: number }>;
  createEntry: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  patchEntry: (id: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getActivityLog: () => Promise<AppUsage[]>;
  checkUpdates: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  onIdleDetected: (cb: (payload: { idleSecs: number }) => void) => () => void;
  onIdleStatus: (cb: (payload: { idleSecs: number; isIdle: boolean }) => void) => () => void;
  onIdleResumed: (cb: () => void) => () => void;
  onAuthChanged: (cb: () => void) => () => void;
  onUpdateAvailable: (cb: () => void) => () => void;
}

declare global {
  interface Window {
    xvaApi: XvaApi;
  }
}
