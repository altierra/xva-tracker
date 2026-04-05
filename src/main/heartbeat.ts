import { getWindowLog } from "./windowLogger";

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let _entryId = "";
let _token = "";
let _portalUrl = "";

async function sendHeartbeat() {
  if (!_entryId || !_token) return;
  const windowLog = getWindowLog();
  try {
    await fetch(`${_portalUrl}/api/timetracker/agent/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${_token}`,
      },
      body: JSON.stringify({
        entryId: _entryId,
        windowLog,
        isIdle: false,
        idleSecs: 0,
        mouseMoves: 0,
        keystrokes: 0,
      }),
    });
  } catch {
    // Network error — silent, will retry next interval
  }
}

export function startHeartbeat(entryId: string, token: string, portalUrl: string) {
  _entryId = entryId;
  _token = token;
  _portalUrl = portalUrl;

  // Send every 30 seconds
  heartbeatInterval = setInterval(sendHeartbeat, 30_000);
  sendHeartbeat(); // immediate
}

export function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  _entryId = "";
}
