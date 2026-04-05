import React, { useState, useEffect, useRef, useCallback } from "react";
import type { AgentConfig, Project } from "../types";

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
    config.runningEntry?.project ? (config.projects.find(p => p.name === config.runningEntry!.project!.name)?.id ?? "") : ""
  );
  const [elapsed, setElapsed] = useState(0);
  const [startTime, setStartTime] = useState<Date | null>(
    config.runningEntry ? new Date(config.runningEntry.startTime) : null
  );
  const [isIdle, setIsIdle] = useState(false);
  const [idleSecs, setIdleSecs] = useState(0);
  const [activityScore, setActivityScore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [portalUrl, setPortalUrl] = useState("https://altierraxva.com");
  const [newPortalUrl, setNewPortalUrl] = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Restore tracking state if there's a running entry
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

  // Elapsed timer tick
  useEffect(() => {
    if (isTracking && startTime) {
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTime.getTime()) / 1000));
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      if (!isTracking) setElapsed(0);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isTracking, startTime]);

  // Idle detection from main process
  useEffect(() => {
    const unsubIdle = window.xvaApi.onIdleDetected(({ idleSecs: s }) => {
      setIsIdle(true);
      setIdleSecs(s);
    });
    const unsubStatus = window.xvaApi.onIdleStatus(({ idleSecs: s, isIdle: idle }) => {
      setIdleSecs(s);
      if (!idle) setIsIdle(false);
      // Rough activity score based on idle time
      if (isTracking && elapsed > 0) {
        const activeFrac = Math.max(0, elapsed - s) / elapsed;
        setActivityScore(Math.round(activeFrac * 100));
      }
    });
    const unsubResumed = window.xvaApi.onIdleResumed(() => {
      setIsIdle(false);
    });
    return () => { unsubIdle(); unsubStatus(); unsubResumed(); };
  }, [isTracking, elapsed]);

  const selectedProject = config.projects.find(p => p.id === selectedProjectId) ?? null;

  const startTimer = async () => {
    if (!description.trim()) {
      setError("Please enter a description before starting.");
      return;
    }
    setLoading(true);
    setError("");

    const token = await window.xvaApi.getToken();
    const url = portalUrl;

    try {
      const now = new Date();
      const weekStart = getWeekStart(now);

      const res = await fetch(`${url}/api/timetracker/entries`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          description: description.trim(),
          projectId: selectedProjectId || null,
          startTime: now.toISOString(),
          weekStart: weekStart.toISOString(),
          isRunning: true,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const entry = data.entry ?? data;
      const entryId = entry.id as string;

      setCurrentEntryId(entryId);
      setStartTime(now);
      setIsTracking(true);

      const projectConfig = selectedProject ?? { screenshotEnabled: false, screenshotIntervalMins: 10 };
      await window.xvaApi.startTracking(entryId, {
        screenshotEnabled: projectConfig.screenshotEnabled,
        screenshotIntervalMins: projectConfig.screenshotIntervalMins,
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to start timer.");
    }

    setLoading(false);
  };

  const stopTimer = async () => {
    if (!currentEntryId) return;
    setLoading(true);
    setError("");

    const token = await window.xvaApi.getToken();
    const url = portalUrl;

    try {
      await window.xvaApi.stopTracking();

      const res = await fetch(`${url}/api/timetracker/entries/${currentEntryId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          isRunning: false,
          endTime: new Date().toISOString(),
          duration: elapsed,
          activityScore: activityScore ?? 0,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      setIsTracking(false);
      setCurrentEntryId(null);
      setStartTime(null);
      setIsIdle(false);
      setActivityScore(null);
      setDescription("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to stop timer.");
    }

    setLoading(false);
  };

  const resumeFromIdle = async () => {
    await window.xvaApi.resumeFromIdle();
    setIsIdle(false);
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

  if (showSettings) {
    return (
      <div style={styles.root}>
        {/* Settings header */}
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
            <p style={{ fontSize: 11, color: "#64748b", margin: "0 0 10px" }}>
              Connected to {portalUrl}
            </p>
            <button
              onClick={() => window.xvaApi.openExternal(`${portalUrl}/dashboard/va/download-agent`)}
              style={styles.btnOutline}
            >
              Manage Token on Portal
            </button>
          </div>

          <div style={styles.settingsSection}>
            <label style={styles.fieldLabel}>Danger Zone</label>
            <button onClick={disconnect} style={styles.btnDanger}>
              Disconnect Account
            </button>
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

  return (
    <div style={styles.root}>
      {/* Top bar */}
      <div style={styles.topBar}>
        <div style={styles.brandWrap}>
          <div style={styles.brandDot} />
          <span style={styles.topBarTitle}>XVA Tracker</span>
        </div>
        <div style={styles.topBarActions}>
          <button onClick={() => window.xvaApi.openExternal(`${portalUrl}/dashboard/va/timetracker`)} style={styles.iconBtn} title="Open Portal">
            ⬡
          </button>
          <button onClick={() => setShowSettings(true)} style={styles.iconBtn} title="Settings">
            ⚙
          </button>
        </div>
      </div>

      {/* Idle banner */}
      {isIdle && (
        <div style={styles.idleBanner}>
          <span>⏸ Idle detected ({Math.round(idleSecs / 60)} min)</span>
          <button onClick={resumeFromIdle} style={styles.resumeBtn}>
            I'm back
          </button>
        </div>
      )}

      <div style={styles.scrollArea}>
        {/* Timer display */}
        <div style={styles.timerSection}>
          <div style={{
            ...styles.timerDisplay,
            color: isTracking ? (isIdle ? "#f59e0b" : "#1855F5") : "#1e2a3a",
          }}>
            {formatElapsed(elapsed)}
          </div>

          {isTracking && activityScore !== null && (
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
            style={{
              ...styles.input,
              opacity: isTracking ? 0.7 : 1,
              cursor: isTracking ? "not-allowed" : "text",
            }}
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
            style={{
              ...styles.input,
              opacity: isTracking ? 0.7 : 1,
              cursor: isTracking ? "not-allowed" : "pointer",
            }}
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

        {/* Project info badges */}
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

        {/* Start/Stop button */}
        <button
          onClick={isTracking ? stopTimer : startTimer}
          disabled={loading}
          style={{
            ...styles.mainBtn,
            background: isTracking ? "#ef4444" : "#1855F5",
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading
            ? "…"
            : isTracking
            ? "⏹  Stop Timer"
            : "▶  Start Timer"}
        </button>
      </div>
    </div>
  );
}

function getWeekStart(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    background: "#0d0f14",
    overflow: "hidden",
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    borderBottom: "1px solid #1e2a3a",
    flexShrink: 0,
    WebkitAppRegion: "drag" as unknown as undefined,
  },
  brandWrap: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  brandDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: "#1855F5",
  },
  topBarTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "#cbd5e1",
  },
  topBarActions: {
    display: "flex",
    gap: 4,
    WebkitAppRegion: "no-drag" as unknown as undefined,
  },
  iconBtn: {
    background: "none",
    border: "none",
    color: "#475569",
    fontSize: 16,
    cursor: "pointer",
    padding: "4px 6px",
    borderRadius: 6,
  },
  backBtn: {
    background: "none",
    border: "none",
    color: "#475569",
    fontSize: 12,
    cursor: "pointer",
    padding: "4px 0",
    width: 60,
    textAlign: "left" as const,
  },
  idleBanner: {
    background: "rgba(245,158,11,0.12)",
    borderBottom: "1px solid rgba(245,158,11,0.25)",
    padding: "8px 16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    fontSize: 12,
    color: "#f59e0b",
    flexShrink: 0,
  },
  resumeBtn: {
    background: "rgba(245,158,11,0.15)",
    border: "1px solid rgba(245,158,11,0.3)",
    borderRadius: 6,
    color: "#f59e0b",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    padding: "4px 10px",
  },
  scrollArea: {
    flex: 1,
    overflowY: "auto" as const,
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  timerSection: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 10,
    padding: "20px 0 8px",
  },
  timerDisplay: {
    fontSize: 52,
    fontWeight: 700,
    fontFamily: "monospace",
    letterSpacing: "-1px",
    transition: "color 0.3s",
  },
  activityRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    maxWidth: 280,
  },
  activityBar: {
    height: 4,
    background: "#1e2a3a",
    borderRadius: 999,
    overflow: "hidden",
    flex: 1,
  },
  activityFill: {
    height: "100%",
    borderRadius: 999,
    transition: "width 0.5s ease, background 0.3s",
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: "#64748b",
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
  },
  input: {
    width: "100%",
    padding: "10px 12px",
    background: "#131720",
    border: "1px solid #1e2a3a",
    borderRadius: 10,
    color: "#e2e8f0",
    fontSize: 13,
    outline: "none",
    boxSizing: "border-box" as const,
    appearance: "none" as const,
  },
  badges: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 6,
    marginTop: -6,
  },
  badge: {
    fontSize: 11,
    color: "#64748b",
    background: "#131720",
    border: "1px solid #1e2a3a",
    borderRadius: 6,
    padding: "3px 8px",
  },
  errorBox: {
    background: "rgba(239,68,68,0.08)",
    border: "1px solid rgba(239,68,68,0.2)",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 12,
    color: "#f87171",
  },
  mainBtn: {
    width: "100%",
    padding: "14px",
    border: "none",
    borderRadius: 12,
    color: "#fff",
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
    transition: "background 0.2s, opacity 0.15s",
    marginTop: 4,
  },
  settingsSection: {
    borderTop: "1px solid #1e2a3a",
    paddingTop: 16,
    marginTop: 16,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  btnSmall: {
    padding: "8px 16px",
    background: "#1855F5",
    border: "none",
    borderRadius: 8,
    color: "#fff",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    alignSelf: "flex-start" as const,
  },
  btnOutline: {
    padding: "8px 16px",
    background: "transparent",
    border: "1px solid #1e2a3a",
    borderRadius: 8,
    color: "#94a3b8",
    fontSize: 12,
    cursor: "pointer",
    alignSelf: "flex-start" as const,
  },
  btnDanger: {
    padding: "8px 16px",
    background: "rgba(239,68,68,0.08)",
    border: "1px solid rgba(239,68,68,0.2)",
    borderRadius: 8,
    color: "#f87171",
    fontSize: 12,
    cursor: "pointer",
    alignSelf: "flex-start" as const,
  },
};
