# XVA Tracker

Desktop time tracking agent for Altierra XVA. Runs in the system tray and syncs time entries, window activity, and optional screenshots to the portal.

## Architecture

- **Main process** (`src/main/`): Electron main, tray, idle detection, IPC handlers
- **Preload** (`src/preload/`): Context bridge exposing safe APIs to the renderer
- **Renderer** (`src/renderer/`): React UI (setup screen + tracker screen)

### Main process modules
| File | Purpose |
|---|---|
| `index.ts` | App lifecycle, tray, window, IPC handlers |
| `heartbeat.ts` | Sends periodic heartbeats with window log to portal |
| `screenshotter.ts` | Periodic screen captures uploaded to Cloudinary via portal |
| `windowLogger.ts` | Polls active window every 10s, builds window log |

## Development

### Prerequisites

- Node.js 20+
- The portal running at `https://altierraxva.com` (or locally)

### Install dependencies

```bash
npm install
```

### Run in development

```bash
npm run dev
```

This starts the TypeScript compiler in watch mode for main/preload, Vite dev server for renderer, and Electron.

## Building distributables

### Before building

Place the following icons in `assets/`:
- `icon.icns` — Mac app icon (512x512)
- `icon.ico` — Windows app icon
- `tray-icon.png` — Menu bar/tray icon (32x32, works on dark background)

### Build for Mac

```bash
npm run dist:mac
```

Outputs a universal `.dmg` in `release/`.

### Build for Windows

```bash
npm run dist:win
```

Outputs an NSIS installer `.exe` in `release/`.

### Build for both platforms

```bash
npm run dist:all
```

## Publishing releases

Releases are published to GitHub releases. Configure:
1. Set `GH_TOKEN` environment variable with a GitHub personal access token
2. Update `owner` and `repo` in `package.json` under `build.publish`
3. Run `npm run dist:mac` or `npm run dist:win`

## Portal integration

The app uses three portal API endpoints (all authenticated via `Bearer` token):

| Endpoint | Purpose |
|---|---|
| `GET /api/timetracker/agent/config` | Fetch projects and running entry |
| `POST /api/timetracker/agent/heartbeat` | Send window log and activity data |
| `POST /api/timetracker/agent/screenshot` | Upload screenshot |

The app also uses the standard time entry endpoints:
- `POST /api/timetracker/entries` — start a new entry
- `PATCH /api/timetracker/entries/:id` — stop an entry

## First-time setup (as a VA)

1. Download XVA Tracker for your OS
2. Open it — it appears in the menu bar / system tray
3. Go to the portal: **Work → Download Agent**
4. Click **Generate Token** and copy it
5. Paste the token into XVA Tracker and click **Connect**
6. Start tracking — your time entries now sync automatically
