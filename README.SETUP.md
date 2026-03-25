# Setup Guide

## A. Config JSON

### 1. Create a Tesla Fleet API credential

1. Go to [developer.tesla.com](https://developer.tesla.com) and sign in with your Tesla account.
2. Create a new application. You will receive a **Client ID** and **Client Secret**.
3. Under "Allowed redirect URIs", add:
   ```
   http://localhost:4545/callback
   ```
4. Under "API scopes", enable at minimum:
   - `vehicle_device_data` — vehicle state, charge, config
   - `vehicle_location` — GPS coordinates
   - `offline_access` — refresh tokens (so you don't re-auth every hour)
   - `user_data` — account identity (email / subject)

   Optionally also:
   - `vehicle_cmds` — needed to send wake_up
   - `vehicle_charging_cmds`

### 2. Create a HERE API geolocation credential

1. Go to [platform.here.com](https://platform.here.com) and create a free account.
2. Create a new project and generate an **API key** (not OAuth — a plain API key).
3. The key is used for reverse geocoding: lat/lon → human-readable address. Results are cached in SQLite so calls are minimal.

### 3. Set home coordinates

Find the latitude and longitude of your home address (e.g. via Google Maps → right-click → copy coordinates).

### Create apiconfig.json

```json
{
  "client_id": "your-tesla-client-id",
  "client_secret": "your-tesla-client-secret",
  "here": "your-here-api-key",
  "home": {
    "latitude": 52.3676,
    "longitude": 4.9041
  }
}
```

`client_secret` is optional depending on your Tesla app type. `here` and `home` are both optional — omit them to skip geocoding and distance calculation.

---

## B. One-off: Authorize your Tesla account

Start the server (it handles the OAuth callback):

```sh
bun start
```

Then open the auth URL in your browser:

```
http://localhost:4545/auth           # EU (default)
http://localhost:4545/auth?region=na # North America
```

You'll be redirected to Tesla's login page. Sign in with the Tesla account that owns the vehicles. After granting access, Tesla redirects back to `http://localhost:4545/callback` and you'll see a confirmation page.

The tokens are saved in `tesla.db`. Re-authorizing an existing account updates the tokens without creating a duplicate.

**Alternative CLI flow** (if you don't want to keep the server running):

```sh
bun auth.ts              # EU
bun auth.ts --region na  # North America
```

This spins up a temporary server just for the callback, then exits.

---

## C. Automate: cron the data refresh

Run `bun refresh.ts` on a schedule to keep the SQLite cache up to date.

```sh
# Example: refresh every 5 minutes
*/5 * * * * cd /path/to/TeslaApi && bun refresh.ts >> /var/log/tesla-refresh.log 2>&1
```

Add to crontab with `crontab -e`.

**Refresh behaviour:**
- Vehicles last seen **less than 10 minutes ago** are skipped (data is fresh).
- Stale or offline vehicles receive a `wake_up` command, then the script waits up to 45 seconds for them to come online before fetching data.
- Static config (model, trim, factory colour) is fetched once and cached indefinitely.
- Skin colour (user-set wrap colour) is re-fetched every 24 hours.

Useful flags:

```sh
bun refresh.ts --force               # ignore the 10-minute window, refresh everything
bun refresh.ts --car <vehicle_id>    # refresh a single vehicle
```

Keep the **server** (`bun start`) running separately so the API is always available. The refresh script writes directly to the same SQLite database.

---

## D. Fetch data from the API

With the server running (`bun start`) and at least one refresh completed, query the endpoints:

```sh
# All vehicles
curl http://localhost:4545/vehicles

# Single vehicle
curl http://localhost:4545/vehicles/<vehicle_id>

# Authorized accounts
curl http://localhost:4545/accounts

# Health check
curl http://localhost:4545/health
```

The response includes location (with reverse-geocoded address and distance from home), charge level, speed, and colour. All data is served from the local SQLite cache — no Tesla API calls are made at read time.

See [README.md](README.md) for full response examples and CLI reference.
