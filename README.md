# Tesla API Tool

Fetches vehicle name, location, speed, and charge from the Tesla Fleet API. Caches everything in SQLite and serves it via a local JSON API.

## TL;DR

```sh
# 1. Start the server
bun start

# 2. Authorize a Tesla account (open the URL in your browser)
bun auth.ts

# 3. Fetch live vehicle data
bun refresh.ts
```

That's it. Hit `http://localhost:4545/vehicles` to see your cars.

---

## CLI reference

| Command | What it does |
|---------|-------------|
| `bun auth.ts` | Authorize a Tesla account via OAuth (CLI version) |
| `bun auth.ts --region na` | Same, for North America |
| `bun deauth.ts --id <id>` | Remove an authorized account and its vehicles |
| `bun account.ts <email\|id> --label <name>` | Give an account a friendly label |
| `bun vehicle.ts <vehicle_id> --alias <name>` | Give a vehicle a friendly alias |
| `bun refresh.ts` | Refresh all vehicle data (skips if seen <10 min ago) |
| `bun refresh.ts --force` | Refresh all, ignoring the 10-minute cache |
| `bun refresh.ts --car <vehicle_id>` | Refresh a single vehicle |
| `bun refresh.ts --verbose` | Print raw `vehicle_config` JSON for debugging |
| `bun start` | Start the API server on port 4545 |
| `bun dev` | Start with hot reload |

## API reference

| Route | What it returns |
|-------|----------------|
| `GET /auth` | Redirect to Tesla OAuth (`?region=na` for North America) |
| `GET /vehicles` | All cached vehicles |
| `GET /vehicles/:id` | Single vehicle by Tesla ID |
| `GET /accounts` | Authorized accounts (no tokens) |
| `GET /health` | `{ ok: true }` |

---

> **New here?** See [README.SETUP.md](README.SETUP.md) for a detailed step-by-step setup guide.

## Setup

1. Register an application at [developer.tesla.com](https://developer.tesla.com) to get a `client_id` and `client_secret`.
   - Set the redirect URI to `http://localhost:4545/callback`
   - Enable scopes: `vehicle_device_data`, `vehicle_location`, `vehicle_cmds`, `vehicle_charging_cmds`, `offline_access`, `user_data`

2. Add credentials to `apiconfig.json`:
   ```json
   {
     "client_id": "your_client_id",
     "client_secret": "your_client_secret",
     "here": "your_here_api_key",
     "home": { "latitude": 51.5074, "longitude": -0.1278 }
   }
   ```

3. Install dependencies:
   ```sh
   bun install
   ```

## CLI Commands

### Authorize an account

**Via the web server** (recommended — server must be running):

```
GET http://localhost:4545/auth           # EU (default)
GET http://localhost:4545/auth?region=na # North America
```

Open the URL in your browser. Tesla redirects back to `/callback` on the same server, completing the flow and showing a confirmation page. Re-authorizing an existing account updates the tokens in-place — the ID, label, and everything else is preserved.

**Via CLI** (server does not need to be running):

```sh
bun auth.ts              # EU (default)
bun auth.ts --region na  # North America
```

### Remove an account

```sh
bun deauth.ts --id 1
```

Deletes the account and all its associated cached vehicles. Find IDs via `GET /accounts`.

### Label an account

```sh
bun account.ts user@example.com --label "Work"
bun account.ts 1 --label "Personal"    # match by numeric ID
bun account.ts <subject-uuid> --label "Wietse"
```

Accepts email address, Tesla subject UUID, or numeric account ID.

### Refresh vehicle data

```sh
bun refresh.ts                          # refresh all vehicles (skip if seen <10 min ago)
bun refresh.ts --force                  # refresh all, ignoring last seen time
bun refresh.ts --car 1234567890123456   # refresh a single vehicle by Tesla ID
bun refresh.ts --verbose                # print raw vehicle_config JSON for each car
```

Flags can be combined:

```sh
bun refresh.ts --car 1234567890123456 --force --verbose
```

**Behaviour:**
- All vehicles for all accounts are refreshed in parallel.
- If a vehicle was last seen **more than 10 minutes ago** (or `--force`), sends a `wake_up` command, waits for it to come online, then fetches live data.
- Static vehicle config (model, trim, factory colour) is fetched once and cached indefinitely.
- Configured skin colour (user-set in the Tesla app, e.g. for wraps) is re-fetched every **24 hours**. If vehicle config is already being fetched for another reason, the skin colour is updated for free.

### Alias a vehicle

```sh
bun vehicle.ts 1234567890123456 --alias "Daily Driver"
```

Sets a persistent alias for a vehicle. The `name` field in the API response returns the alias when set, falling back to the Tesla display name. Find vehicle IDs via `GET /vehicles`.

### Start the API server

```sh
bun start          # production (default port 4545)
bun dev            # with hot reload
PORT=8080 bun start
```

## API Endpoints

| Route | Description |
|-------|-------------|
| `GET /auth` | Start OAuth flow — redirects to Tesla (`?region=na` for North America) |
| `GET /callback` | OAuth callback — handled automatically by Tesla redirect |
| `GET /vehicles` | All cached vehicles |
| `GET /vehicles/:id` | Single vehicle by Tesla vehicle ID |
| `GET /accounts` | Authorized accounts (no tokens exposed) |
| `GET /health` | Health check |

### Example response – `GET /vehicles`

```json
[
  {
    "id": "1234567890123456",
    "vin": "5YJ3E1EA1NF000001",
    "name": "Daily Driver",
    "display_name": "Ilse",
    "model": "Model 3",
    "type": "74d",
    "color": "MidnightSilver",
    "skin_color": "#580908",
    "state": "online",
    "location": {
      "latitude": 51.5074,
      "longitude": -0.1278,
      "address": "Damrak, Amsterdam, Noord-Holland, Netherlands",
      "distance_m": 1240
    },
    "speed_kmh": 0,
    "charge": { "level_pct": 69, "state": "Disconnected" },
    "last_seen": "2026-03-25T09:14:35.000Z",
    "last_updated": "2026-03-25T09:14:45.000Z"
  }
]
```

### Example response – `GET /accounts`

```json
[
  {
    "id": 3,
    "label": "Wietse",
    "identity": "00000000-0000-0000-0000-000000000000",
    "region": "eu",
    "created_at": "2026-03-25T09:22:20.000Z"
  }
]
```

## API call efficiency

| Data | Fetched |
|------|---------|
| Vehicle list + state | Every refresh |
| Location, speed, charge | Every refresh (live data) |
| Model, trim, factory colour | Once, cached indefinitely |
| Skin colour | Every 24h (or when config is fetched anyway) |

## Project structure

```
auth.ts          – OAuth authorization CLI
deauth.ts        – Remove authorized account by ID
account.ts       – Set a label on an account
vehicle.ts       – Set an alias on a vehicle
refresh.ts       – Vehicle data refresh CLI
server.ts        – Bun HTTP server (default port 4545), includes /auth + /callback
apiconfig.json   – Credentials and config (client_id, client_secret, here, home)
src/
  auth-flow.ts   – Shared OAuth logic (PKCE, token exchange, account save)
  config.ts      – Loads apiconfig.json
  db.ts          – SQLite schema & helpers (bun:sqlite)
  tesla-api.ts   – Tesla Fleet API client (tokens, vehicles, wake_up)
  geocode.ts     – HERE reverse geocoding with SQLite cache
tesla.db         – SQLite database (created on first run)
```
