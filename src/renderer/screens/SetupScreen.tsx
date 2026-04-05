import React, { useState } from "react";

interface Props {
  onConnected: () => void;
}

export function SetupScreen({ onConnected }: Props) {
  const [token, setToken] = useState("");
  const [portalUrl, setPortalUrl] = useState("https://altierraxva.com");
  const [step, setStep] = useState<"token" | "testing" | "error">("token");
  const [errorMsg, setErrorMsg] = useState("");

  const connect = async () => {
    if (!token.trim()) return;
    setStep("testing");
    setErrorMsg("");

    await window.xvaApi.setPortalUrl(portalUrl.replace(/\/$/, ""));
    await window.xvaApi.setToken(token.trim());

    const result = await window.xvaApi.fetchConfig();
    if (result.ok) {
      onConnected();
    } else {
      setErrorMsg(result.error || "Connection failed. Check your token and try again.");
      await window.xvaApi.clearToken();
      setStep("error");
    }
  };

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.logo}>XVA</div>
        <p style={styles.logoSub}>Tracker</p>
      </div>

      <div style={styles.card}>
        <h2 style={styles.title}>Connect to Portal</h2>
        <p style={styles.subtitle}>
          Enter your connection token from{" "}
          <button style={styles.link} onClick={() => window.xvaApi.openExternal(`${portalUrl}/dashboard/va/download-agent`)}>
            altierraxva.com
          </button>
        </p>

        <div style={styles.field}>
          <label style={styles.label}>Connection Token</label>
          <input
            style={styles.input}
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="Paste your token here"
            onKeyDown={e => { if (e.key === "Enter") connect(); }}
            disabled={step === "testing"}
            autoFocus
          />
        </div>

        <details style={styles.advanced}>
          <summary style={styles.advancedSummary}>Advanced</summary>
          <div style={{ ...styles.field, marginTop: 12 }}>
            <label style={styles.label}>Portal URL</label>
            <input
              style={styles.input}
              type="text"
              value={portalUrl}
              onChange={e => setPortalUrl(e.target.value)}
              placeholder="https://altierraxva.com"
            />
          </div>
        </details>

        {step === "error" && (
          <div style={styles.error}>{errorMsg}</div>
        )}

        <button
          style={{ ...styles.btn, ...(step === "testing" ? styles.btnDisabled : {}) }}
          onClick={connect}
          disabled={step === "testing" || !token.trim()}
        >
          {step === "testing" ? "Connecting…" : "Connect"}
        </button>
      </div>

      <p style={styles.footer}>
        Generate your token at{" "}
        <button style={styles.link} onClick={() => window.xvaApi.openExternal(`${portalUrl}/dashboard/va/download-agent`)}>
          Dashboard → Work → Download Agent
        </button>
      </p>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100vh",
    padding: "24px",
    background: "#0d0f14",
  },
  header: {
    textAlign: "center",
    marginBottom: 32,
  },
  logo: {
    fontSize: 36,
    fontWeight: 800,
    color: "#1855F5",
    letterSpacing: "-1px",
  },
  logoSub: {
    fontSize: 14,
    color: "#64748b",
    marginTop: -4,
    letterSpacing: "3px",
    textTransform: "uppercase" as const,
  },
  card: {
    width: "100%",
    maxWidth: 340,
    background: "#161b27",
    border: "1px solid #1e2a3a",
    borderRadius: 16,
    padding: "24px 20px",
  },
  title: {
    fontSize: 16,
    fontWeight: 600,
    color: "#f1f5f9",
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 12,
    color: "#64748b",
    marginBottom: 20,
    lineHeight: 1.5,
  },
  field: {
    marginBottom: 14,
  },
  label: {
    display: "block",
    fontSize: 11,
    color: "#64748b",
    marginBottom: 6,
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
  },
  input: {
    width: "100%",
    background: "#0d0f14",
    border: "1px solid #1e2a3a",
    borderRadius: 10,
    padding: "10px 12px",
    color: "#f1f5f9",
    fontSize: 13,
    outline: "none",
  },
  advanced: {
    marginBottom: 16,
  },
  advancedSummary: {
    fontSize: 11,
    color: "#475569",
    cursor: "pointer",
  },
  error: {
    background: "#3f1f1f",
    border: "1px solid #7f1d1d",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 12,
    color: "#fca5a5",
    marginBottom: 14,
  },
  btn: {
    width: "100%",
    background: "#1855F5",
    color: "white",
    border: "none",
    borderRadius: 10,
    padding: "12px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  btnDisabled: {
    opacity: 0.5,
    cursor: "not-allowed",
  },
  link: {
    background: "none",
    border: "none",
    color: "#1855F5",
    cursor: "pointer",
    fontSize: "inherit",
    padding: 0,
    textDecoration: "underline",
  },
  footer: {
    fontSize: 11,
    color: "#475569",
    marginTop: 20,
    textAlign: "center",
  },
};
