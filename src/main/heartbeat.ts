import { getWindowLog } from "./windowLogger";

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let _entryId = "";
let _token = "";
let _portalUrl = "";
// Bug 3 fix: track how many window log entries were sent last heartbeat
// so we only send NEW entries each time, preventing duplicates in the DB.
let _lastSentCount = 0;

async function sendHeartbeat() {
  if (!_entryId || !_token) return;
  const allEntries = getWindowLog();
  // Only send entries that weren't in the previous heartbeat
  const newEntries = allEntries.slice(_lastSentCount);
  _lastSentCount = allEntries.length;
  try {
    await fetch(`${_portalUrl}/api/timetracker/agent/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${_token}`,
      },
      // Bug 7 fix: removed hardcoded isIdle/idleSecs/mouseMoves/keystrokes —
      // the server ignores them and they were always wrong (idle state lives
      // in the renderer, not here). windowLog sends only new entries.
      body: JSON.stringify({ entryId: _entryId, windowLog: newEntries }),
    });
  } catch {
    // Network error — silent, will retry next interval
  }
}

export function startHeartbeat(entryId: string, token: string, portalUrl: string) {
  _entryId = entryId;
  _token = token;
  _portalUrl = portalUrl;
  _lastSentCount = 0; // reset on each new session

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
