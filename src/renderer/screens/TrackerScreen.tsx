import React, { useState, useEffect, useRef, useCallback } from "react";
import type { AgentConfig, AppUsage } from "../types";

interface Props {
  config: AgentConfig;
  onRefresh: () => void;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function formatElapsed(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function getActivityColor(score: number): string {
  if (score >= 70) return "#10b981";
  if (score >= 40) return "#f59e0b";
  return "#ef4444";
}

export function TrackerScreen({ config, onRefresh }: Props) {
  const [isTracking, setIsTracking] = useState(false);
  const [currentEntryId, setCurrentEntryId] = useState<string | null>(config.runningEntry?.id ?? null);
  const [description, setDescription] = useState(config.runningEntry?.description ?? "");
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    config.runningEntry?.project
      ? (config.projects.find(p => p.name === config.runningEntry!.project!.name)?.id ?? "")
      : ""
  );
  const [elapsed, setElapsed] = useState(0);
  const [startTime, setStartTime] = useState<Date | null>(
    config.runningEntry ? new Date(config.runningEntry.startTime) : null
  );
  const [isIdle, setIsIdle] = useState(false);
  const [idleSecs, setIdleSecs] = useState(0);
  const [isManuallyPaused, setIsManuallyPaused] = useState(false);
  const [activityScore, setActivityScore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [portalUrl, setPortalUrl] = useState("https://altierraxva.com");
  const [newPortalUrl, setNewPortalUrl] = useState("");
  const [activityLog, setActivityLog] = useState<AppUsage[]>([]);
  const [showActivity, setShowActivity] = useState(false);

  // ─── Pause tracking refs ─────────────────────────────────────────────────
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pauseOffsetRef = useRef<number>(0);           // total accumulated pause ms
  const idlePauseStartRef = useRef<number | null>(null);   // epoch ms when idle pause began
  const manualPauseStartRef = useRef<number | null>(null); // epoch ms when manual pause began
  // Mirror elapsed in a ref so idle useEffect doesn't re-run every second
  const elapsedRef = useRef<number>(0);
  // Collect idle periods to send to portal on stop
  const idlePeriodsRef = useRef<{ start: string; end: string; durationSecs: number }[]>([]);

  // Total paused ms right now (both sources combined)
  const totalPausedMs = useCallback(() => {
    const idleMs = idlePauseStartRef.current !== null ? Date.now() - idlePauseStartRef.current : 0;
    const manMs = manualPauseStartRef.current !== null ? Date.now() - manualPauseStartRef.current : 0;
    return pauseOffsetRef.current + idleMs + manMs;
  }, []);

  // Flush idle pause into offset and record the period
  const flushIdlePause = useCallback(() => {
    if (idlePauseStartRef.current !== null) {
      const startMs = idlePauseStartRef.current;
      const endMs = Date.now();
      pauseOffsetRef.current += endMs - startMs;
      idlePeriodsRef.current.push({
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        durationSecs: Math.round((endMs - startMs) / 1000),
      });
      idlePauseStartRef.current = null;
    }
  }, []);

  // Flush manual pause into offset
  const flushManualPause = useCallback(() => {
    if (manualPauseStartRef.current !== null) {
      pauseOffsetRef.current += Date.now() - manualPauseStartRef.current;
      manualPauseStartRef.current = null;
    }
  }, []);

  // ─── Restore running entry on load ───────────────────────────────────────
  useEffect(() => {
    if (config.runningEntry) {
      setIsTracking(true);
      setCurrentEntryId(config.runningEntry.id);
      const proj = config.projects.find(p => p.name === config.runningEntry!.project?.name);
      if (proj) setSelectedProjectId(proj.id);
    }
    window.xvaApi.getPortalUrl().then(url => {
      setPortalUrl(url);
      setNewPortalUrl(url);
    });
  }, [config]);

  // ─── Timer tick (net of all pauses) ──────────────────────────────────────
  useEffect(() => {
    if (isTracking && startTime) {
      timerRef.current = setInterval(() => {
        const net = Math.max(0, Date.now() - startTime.getTime() - totalPausedMs());
        const secs = Math.floor(net / 1000);
        elapsedRef.current = secs;
        setElapsed(secs);
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      if (!isTracking) { elapsedRef.current = 0; setElapsed(0); }
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isTracking, startTime, totalPausedMs]);

  // ─── Idle detection from main process ────────────────────────────────────
  // NOTE: elapsed is intentionally NOT in deps — use elapsedRef.current instead.
  // Having elapsed here would tear down/re-add the IPC listener every second,
  // which can cause the one-shot "idle-detected" event to be silently dropped.
  useEffect(() => {
    const unsubIdle = window.xvaApi.onIdleDetected(({ idleSecs: s }) => {
      setIsIdle(true);
      setIdleSecs(s);
      // Only start idle pause if not already idle-paused
      if (idlePauseStartRef.current === null) {
        // Back-date pause start to when idle actually began
        idlePauseStartRef.current = Date.now() - s * 1000;
      }
    });

    const unsubStatus = window.xvaApi.onIdleStatus(({ idleSecs: s, isIdle: idle }) => {
      // Keep banner time accurate while idle
      if (idle) setIdleSecs(s);
      // Do NOT auto-resume — user must click "I'm back"

      // Activity score — read elapsed from ref to avoid stale closure
      const cur = elapsedRef.current;
      if (isTracking && cur > 0) {
        const pausedSecs = Math.floor(totalPausedMs() / 1000);
        const activeFrac = Math.max(0, cur - pausedSecs) / Math.max(1, cur);
        setActivityScore(Math.round(activeFrac * 100));
      }
    });

    // Ignore automatic idle-resumed events — only the button triggers resume
    const unsubResumed = window.xvaApi.onIdleResumed(() => {});

    return () => { unsubIdle(); unsubStatus(); unsubResumed(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTracking, totalPausedMs]);

  // ─── Activity log refresh ─────────────────────────────────────────────────
  useEffect(() => {
    if (!isTracking) { setActivityLog([]); return; }
    const fetch = () => window.xvaApi.getActivityLog().then(setActivityLog).catch(() => {});
    fetch();
    const iv = setInterval(fetch, 30_000);
    return () => clearInterval(iv);
  }, [isTracking]);

  const selectedProject = config.projects.find(p => p.id === selectedProjectId) ?? null;
  const isPaused = isIdle || isManuallyPaused;

  // ─── Actions ──────────────────────────────────────────────────────────────
  const startTimer = async () => {
    if (!description.trim()) { setError("Please enter a description before starting."); return; }
    setLoading(true);
    setError("");
    try {
      const now = new Date();
      // Reset all pause state
      pauseOffsetRef.current = 0;
      idlePauseStartRef.current = null;
      manualPauseStartRef.current = null;
      idlePeriodsRef.current = [];

      const data = await window.xvaApi.createEntry({
        description: description.trim(),
        projectId: selectedProjectId || null,
        startTime: now.toISOString(),
        weekStart: getWeekStart(now).toISOString(),
        isRunning: true,
      });
      const entry = data.entry ?? data;
      const entryId = entry.id as string;
      setCurrentEntryId(entryId);
      setStartTime(now);
      setIsTracking(true);
      const pc = selectedProject ?? { screenshotEnabled: false, screenshotIntervalMins: 10 };
      await window.xvaApi.startTracking(entryId, {
        screenshotEnabled: pc.screenshotEnabled,
        screenshotIntervalMins: pc.screenshotIntervalMins,
      });
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      // Strip Electron IPC wrapper: "Error invoking remote method 'X': Error: actual message"
      const msg = raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
      setError(msg);
    }
    setLoading(false);
  };

  const pauseTimer = () => {
    if (manualPauseStartRef.current === null) {
      manualPauseStartRef.current = Date.now();
      setIsManuallyPaused(true);
    }
  };

  const resumeTimer = () => {
    flushManualPause();
    setIsManuallyPaused(false);
  };

  const resumeFromIdle = async () => {
    await window.xvaApi.resumeFromIdle();
    flushIdlePause();
    setIsIdle(false);
  };

  const stopTimer = async () => {
    if (!currentEntryId) return;
    setLoading(true);
    setError("");
    try {
      // Finalize both pauses so elapsed is accurate
      flushIdlePause();
      flushManualPause();

      // Fetch full window log before stopping (clears on next startTracking)
      let windowLog: unknown[] = [];
      try { windowLog = await window.xvaApi.getWindowLog(); } catch { /* no-op */ }

      await window.xvaApi.stopTracking();
      await window.xvaApi.patchEntry(currentEntryId, {
        isRunning: false,
        endTime: new Date().toISOString(),
        duration: elapsed,
        activityScore: activityScore ?? 0,
        windowLog: windowLog.length > 0 ? windowLog : undefined,
        idlePeriods: idlePeriodsRef.current.length > 0 ? idlePeriodsRef.current : undefined,
      });
      setIsTracking(false);
      setCurrentEntryId(null);
      setStartTime(null);
      setIsIdle(false);
      setIsManuallyPaused(false);
      setActivityScore(null);
      setActivityLog([]);
      setShowActivity(false);
      setDescription("");
      pauseOffsetRef.current = 0;
      idlePauseStartRef.current = null;
      manualPauseStartRef.current = null;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to stop timer.");
    }
    setLoading(false);
  };

  const savePortalUrl = async () => {
    await window.xvaApi.setPortalUrl(newPortalUrl.trim());
    setPortalUrl(newPortalUrl.trim());
    setShowSettings(false);
  };

  const disconnect = async () => {
    if (isTracking) await stopTimer();
    await window.xvaApi.clearToken();
    onRefresh();
  };

  // ─── Settings screen ──────────────────────────────────────────────────────
  if (showSettings) {
    return (
      <div style={styles.root}>
        <div style={styles.topBar}>
          <button onClick={() => setShowSettings(false)} style={styles.backBtn}>← Back</button>
          <span style={styles.topBarTitle}>Settings</span>
          <div style={{ width: 60 }} />
        </div>
        <div style={styles.scrollArea}>
          <div style={styles.settingsSection}>
            <label style={styles.fieldLabel}>Portal URL</label>
            <input
              style={styles.input}
              type="url"
              value={newPortalUrl}
              onChange={e => setNewPortalUrl(e.target.value)}
              placeholder="https://altierraxva.com"
            />
            <button onClick={savePortalUrl} style={styles.btnSmall}>Save</button>
          </div>
          <div style={styles.settingsSection}>
            <label style={styles.fieldLabel}>Connection</label>
            <p style={{ fontSize: 11, color: "#64748b", margin: "0 0 10px" }}>Connected to {portalUrl}</p>
            <button
              onClick={() => window.xvaApi.openExternal(`${portalUrl}/dashboard/va/download-agent`)}
              style={styles.btnOutline}
            >
              Manage Token on Portal
            </button>
          </div>
          <div style={styles.settingsSection}>
            <label style={styles.fieldLabel}>Danger Zone</label>
            <button onClick={disconnect} style={styles.btnDanger}>Disconnect Account</button>
          </div>
          <div style={{ ...styles.settingsSection, borderTop: "none" }}>
            <p style={{ fontSize: 10, color: "#334155", textAlign: "center" as const }}>
              XVA Tracker v1.0.0 — by Altierra XVA
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ─── Main screen ──────────────────────────────────────────────────────────
  return (
    <div style={styles.root}>
      {/* Top bar */}
      <div style={styles.topBar}>
        <div style={styles.brandWrap}>
          <div style={styles.brandDot} />
          <span style={styles.topBarTitle}>XVA Tracker</span>
        </div>
        <div style={styles.topBarActions}>
          <button
            onClick={() => window.xvaApi.openExternal(`${portalUrl}/dashboard/va/timetracker`)}
            style={styles.iconBtn}
            title="Open Portal"
          >⬡</button>
          <button onClick={() => setShowSettings(true)} style={styles.iconBtn} title="Settings">⚙</button>
        </div>
      </div>

      {/* Idle banner */}
      {isIdle && (
        <div style={styles.idleBanner}>
          <span>💤 Idle detected ({Math.round(idleSecs / 60)} min) — timer paused</span>
          <button onClick={resumeFromIdle} style={styles.resumeBtn}>I'm back</button>
        </div>
      )}

      <div style={styles.scrollArea}>
        {/* Timer display */}
        <div style={styles.timerSection}>
          <div style={{
            ...styles.timerDisplay,
            color: !isTracking ? "#1e2a3a" : isPaused ? "#f59e0b" : "#1855F5",
          }}>
            {formatElapsed(elapsed)}
          </div>

          {/* Pause label */}
          {isPaused && isTracking && (
            <div style={styles.pauseLabel}>
              {isManuallyPaused && !isIdle ? "⏸ PAUSED" : "⏸ PAUSED (IDLE)"}
            </div>
          )}

          {isTracking && activityScore !== null && !isPaused && (
            <div style={styles.activityRow}>
              <div style={{ ...styles.activityBar, width: "100%" }}>
                <div style={{
                  ...styles.activityFill,
                  width: `${activityScore}%`,
                  background: getActivityColor(activityScore),
                }} />
              </div>
              <span style={{ fontSize: 11, color: getActivityColor(activityScore), minWidth: 36 }}>
                {activityScore}%
              </span>
            </div>
          )}
        </div>

        {/* Description */}
        <div style={styles.field}>
          <label style={styles.fieldLabel}>What are you working on?</label>
          <input
            style={{ ...styles.input, opacity: isTracking ? 0.7 : 1, cursor: isTracking ? "not-allowed" : "text" }}
            type="text"
            value={description}
            onChange={e => !isTracking && setDescription(e.target.value)}
            placeholder="e.g. Scheduling client meetings"
            disabled={isTracking}
            onKeyDown={e => { if (e.key === "Enter" && !isTracking) startTimer(); }}
          />
        </div>

        {/* Project */}
        <div style={styles.field}>
          <label style={styles.fieldLabel}>Project</label>
          <select
            style={{ ...styles.input, opacity: isTracking ? 0.7 : 1, cursor: isTracking ? "not-allowed" : "pointer" }}
            value={selectedProjectId}
            onChange={e => !isTracking && setSelectedProjectId(e.target.value)}
            disabled={isTracking}
          >
            <option value="">— No project —</option>
            {config.projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        {/* Project badges */}
        {selectedProject && (
          <div style={styles.badges}>
            {selectedProject.screenshotEnabled && (
              <span style={styles.badge}>📸 Screenshots every {selectedProject.screenshotIntervalMins}m</span>
            )}
            {selectedProject.dailyLimitMins && (
              <span style={styles.badge}>⏱ {selectedProject.dailyLimitMins / 60}h daily limit</span>
            )}
          </div>
        )}

        {/* Error */}
        {error && <div style={styles.errorBox}>{error}</div>}

        {/* Button row */}
        {isTracking ? (
          <div style={styles.btnRow}>
            {/* Pause / Resume */}
            {isManuallyPaused ? (
              <button onClick={resumeTimer} disabled={loading} style={styles.resumeTimerBtn}>
                ▶ Resume
              </button>
            ) : (
              <button onClick={pauseTimer} disabled={loading || isIdle} style={styles.pauseTimerBtn}>
                ⏸ Pause
              </button>
            )}
            {/* Stop */}
            <button
              onClick={stopTimer}
              disabled={loading}
              style={{ ...styles.stopBtn, opacity: loading ? 0.6 : 1 }}
            >
              {loading ? "…" : "⏹ Stop"}
            </button>
          </div>
        ) : (
          <button
            onClick={startTimer}
            disabled={loading}
            style={{ ...styles.mainBtn, background: "#1855F5", opacity: loading ? 0.6 : 1 }}
          >
            {loading ? "…" : "▶  Start Timer"}
          </button>
        )}

        {/* Session Activity */}
        {isTracking && activityLog.length > 0 && (
          <div style={styles.activitySection}>
            <button onClick={() => setShowActivity(v => !v)} style={styles.activityToggle}>
              <span>📊 Session Activity</span>
              <span style={{ opacity: 0.5 }}>{showActivity ? "▲" : "▼"}</span>
            </button>
            {showActivity && (
              <div style={styles.activityList}>
                {activityLog.map(item => (
                  <div key={item.app} style={styles.activityItem}>
                    <div style={styles.activityAppDot} />
                    <span style={styles.activityAppName}>{item.app}</span>
                    <span style={styles.activityDur}>{formatDuration(item.durationSecs)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function getWeekStart(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", height: "100vh", background: "#0d0f14", overflow: "hidden" },
  topBar: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    // On macOS hiddenInset titlebar, traffic lights occupy ~70px on the left
    padding: window.xvaApi.platform === "darwin" ? "12px 16px 12px 80px" : "12px 16px",
    borderBottom: "1px solid #1e2a3a", flexShrink: 0,
    WebkitAppRegion: "drag" as unknown as undefined,
  },
  brandWrap: { display: "flex", alignItems: "center", gap: 8 },
  brandDot: { width: 8, height: 8, borderRadius: "50%", background: "#1855F5" },
  topBarTitle: { fontSize: 13, fontWeight: 600, color: "#cbd5e1" },
  topBarActions: { display: "flex", gap: 4, WebkitAppRegion: "no-drag" as unknown as undefined },
  iconBtn: { background: "none", border: "none", color: "#475569", fontSize: 16, cursor: "pointer", padding: "4px 6px", borderRadius: 6 },
  backBtn: { background: "none", border: "none", color: "#475569", fontSize: 12, cursor: "pointer", padding: "4px 0", width: 60, textAlign: "left" as const },
  idleBanner: {
    background: "rgba(245,158,11,0.12)", borderBottom: "1px solid rgba(245,158,11,0.25)",
    padding: "8px 16px", display: "flex", alignItems: "center", justifyContent: "space-between",
    fontSize: 12, color: "#f59e0b", flexShrink: 0,
  },
  resumeBtn: {
    background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.3)",
    borderRadius: 6, color: "#f59e0b", fontSize: 11, fontWeight: 600, cursor: "pointer", padding: "4px 10px",
  },
  scrollArea: { flex: 1, overflowY: "auto" as const, padding: "16px", display: "flex", flexDirection: "column", gap: 14 },
  timerSection: { display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "20px 0 8px" },
  timerDisplay: { fontSize: 52, fontWeight: 700, fontFamily: "monospace", letterSpacing: "-1px", transition: "color 0.3s" },
  pauseLabel: { fontSize: 11, fontWeight: 700, color: "#f59e0b", letterSpacing: "0.1em" },
  activityRow: { display: "flex", alignItems: "center", gap: 8, width: "100%", maxWidth: 280 },
  activityBar: { height: 4, background: "#1e2a3a", borderRadius: 999, overflow: "hidden", flex: 1 },
  activityFill: { height: "100%", borderRadius: 999, transition: "width 0.5s ease, background 0.3s" },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  fieldLabel: { fontSize: 11, fontWeight: 600, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: "0.06em" },
  input: {
    width: "100%", padding: "10px 12px", background: "#131720", border: "1px solid #1e2a3a",
    borderRadius: 10, color: "#e2e8f0", fontSize: 13, outline: "none",
    boxSizing: "border-box" as const, appearance: "none" as const,
  },
  badges: { display: "flex", flexWrap: "wrap" as const, gap: 6, marginTop: -6 },
  badge: { fontSize: 11, color: "#64748b", background: "#131720", border: "1px solid #1e2a3a", borderRadius: 6, padding: "3px 8px" },
  errorBox: { background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 10, padding: "10px 12px", fontSize: 12, color: "#f87171" },
  // Button row (when tracking)
  btnRow: { display: "flex", gap: 10, marginTop: 4 },
  pauseTimerBtn: {
    flex: 1, padding: "14px", border: "1px solid #1e2a3a", borderRadius: 12,
    background: "#131720", color: "#94a3b8", fontSize: 14, fontWeight: 700, cursor: "pointer",
    transition: "background 0.2s",
  },
  resumeTimerBtn: {
    flex: 1, padding: "14px", border: "none", borderRadius: 12,
    background: "#10b981", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer",
    transition: "background 0.2s",
  },
  stopBtn: {
    flex: 1, padding: "14px", border: "none", borderRadius: 12,
    background: "#ef4444", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer",
    transition: "background 0.2s, opacity 0.15s",
  },
  mainBtn: {
    width: "100%", padding: "14px", border: "none", borderRadius: 12,
    color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer",
    transition: "background 0.2s, opacity 0.15s", marginTop: 4,
  },
  activitySection: { background: "#0d1117", border: "1px solid #1e2a3a", borderRadius: 10, overflow: "hidden" },
  activityToggle: {
    width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "10px 12px", background: "none", border: "none", color: "#64748b",
    fontSize: 11, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.06em", cursor: "pointer",
  },
  activityList: { borderTop: "1px solid #1e2a3a", padding: "8px 0 4px" },
  activityItem: { display: "flex", alignItems: "center", gap: 8, padding: "5px 12px" },
  activityAppDot: { width: 6, height: 6, borderRadius: "50%", background: "#1855F5", flexShrink: 0 },
  activityAppName: { flex: 1, fontSize: 12, color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  activityDur: { fontSize: 11, color: "#475569", fontVariantNumeric: "tabular-nums", flexShrink: 0 },
  settingsSection: { borderTop: "1px solid #1e2a3a", paddingTop: 16, marginTop: 16, display: "flex", flexDirection: "column", gap: 8 },
  btnSmall: { padding: "8px 16px", background: "#1855F5", border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer", alignSelf: "flex-start" as const },
  btnOutline: { padding: "8px 16px", background: "transparent", border: "1px solid #1e2a3a", borderRadius: 8, color: "#94a3b8", fontSize: 12, cursor: "pointer", alignSelf: "flex-start" as const },
  btnDanger: { padding: "8px 16px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, color: "#f87171", fontSize: 12, cursor: "pointer", alignSelf: "flex-start" as const },
};
