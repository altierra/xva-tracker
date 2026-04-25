import React, { useState, useEffect, useCallback, useRef, Component } from "react";
import type { AgentConfig, Project, RunningEntry } from "./types";
import { SetupScreen } from "./screens/SetupScreen";
import { TrackerScreen } from "./screens/TrackerScreen";

type Screen = "loading" | "setup" | "tracker";

class ErrorBoundary extends Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", background: "#0d0f14", padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>⚠️</div>
          <p style={{ color: "#f87171", fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Something went wrong</p>
          <p style={{ color: "#64748b", fontSize: 11, marginBottom: 16, maxWidth: 260 }}>{this.state.error.message}</p>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ padding: "8px 16px", background: "#1855F5", border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);

  const loadConfig = useCallback(async () => {
    const token = await window.xvaApi.getToken();
    if (!token) {
      setScreen("setup");
      return;
    }
    const result = await window.xvaApi.fetchConfig();
    if (result.ok && result.data) {
      setConfig(result.data);
      setScreen("tracker");
    } else {
      // Token invalid or network error — go to setup
      setScreen("setup");
    }
  }, []);

  useEffect(() => {
    loadConfig();

    const unsubAuth = window.xvaApi.onAuthChanged(loadConfig);
    const unsubUpdate = window.xvaApi.onUpdateReady(() => setUpdateAvailable(true));

    return () => {
      unsubAuth();
      unsubUpdate();
    };
  }, [loadConfig]);

  if (screen === "loading") {
    return (
      <div style={styles.center}>
        <div style={styles.spinner} />
      </div>
    );
  }

  if (screen === "setup") {
    return <SetupScreen onConnected={loadConfig} />;
  }

  return (
    <ErrorBoundary>
      {updateAvailable && (
        <div style={styles.updateBanner}>
          <span style={{ marginRight: 8 }}>🎉 A new version of XVA Tracker is ready to install.</span>
          <button style={styles.updateBtn} onClick={() => window.xvaApi.installUpdate()}>Restart & Update Now</button>
        </div>
      )}
      <TrackerScreen config={config!} onRefresh={loadConfig} />
    </ErrorBoundary>
  );
}

const styles: Record<string, React.CSSProperties> = {
  center: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100vh",
    background: "#0d0f14",
  },
  spinner: {
    width: 32,
    height: 32,
    border: "3px solid rgba(24,85,245,0.3)",
    borderTop: "3px solid #1855F5",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  updateBanner: {
    background: "#1855F5",
    color: "#ffffff",
    fontSize: 12,
    fontWeight: 600,
    padding: "8px 16px",
    textAlign: "center",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  updateBtn: {
    background: "#ffffff",
    border: "none",
    color: "#1855F5",
    fontWeight: 700,
    fontSize: 11,
    padding: "3px 10px",
    borderRadius: 6,
    cursor: "pointer",
  },
};
