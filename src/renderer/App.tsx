import React, { useState, useEffect, useCallback, useRef } from "react";
import type { AgentConfig, Project, RunningEntry } from "./types";
import { SetupScreen } from "./screens/SetupScreen";
import { TrackerScreen } from "./screens/TrackerScreen";

type Screen = "loading" | "setup" | "tracker";

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
    const unsubUpdate = window.xvaApi.onUpdateAvailable(() => setUpdateAvailable(true));

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
    <>
      {updateAvailable && (
        <div style={styles.updateBanner}>
          A new version is available — <button style={styles.updateBtn} onClick={() => window.xvaApi.checkUpdates()}>Restart & Update</button>
        </div>
      )}
      <TrackerScreen config={config!} onRefresh={loadConfig} />
    </>
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
    background: "#1e3a5f",
    color: "#93c5fd",
    fontSize: 12,
    padding: "6px 16px",
    textAlign: "center",
  },
  updateBtn: {
    background: "none",
    border: "none",
    color: "#60a5fa",
    textDecoration: "underline",
    cursor: "pointer",
    fontSize: 12,
  },
};
