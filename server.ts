#!/usr/bin/env bun
/**
 * Tesla API web server
 *
 * Routes:
 *   GET /auth              – start OAuth flow (redirects to Tesla)
 *   GET /auth?region=na    – start OAuth flow for NA region
 *   GET /callback          – OAuth callback (Tesla redirects here)
 *   GET /vehicles          – all cached vehicles
 *   GET /vehicles/:id      – single vehicle by vehicle_id
 *   GET /accounts          – list authorized accounts (no tokens)
 *   GET /health            – health check
 */
import { getDb } from "./src/db";
import { reverseGeocode } from "./src/geocode";
import { getConfig } from "./src/config";
import { generatePkce, buildAuthUrl, exchangeCode, saveAccount } from "./src/auth-flow";
import type { Vehicle, Account } from "./src/db";

const PORT = Number(process.env.PORT ?? 4545);
const db   = getDb();
const { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, home } = getConfig();
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

// In-memory PKCE session store: state → { codeVerifier, region }
// Entries expire after 10 minutes to avoid leaking memory
const pendingAuth = new Map<string, { codeVerifier: string; region: string; expiresAt: number }>();

function prunePending() {
  const now = Date.now();
  for (const [k, v] of pendingAuth) {
    if (v.expiresAt < now) pendingAuth.delete(k);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

async function vehicleToJson(v: Vehicle) {
  let location: { latitude: number; longitude: number; address: string | null; distance_m: number | null } | null = null;
  if (v.latitude !== null && v.longitude !== null) {
    const address    = await reverseGeocode(db, v.latitude, v.longitude);
    const distance_m = home
      ? haversineMeters(v.latitude, v.longitude, home.latitude, home.longitude)
      : null;
    location = { latitude: v.latitude, longitude: v.longitude, address, distance_m };
  }
  return {
    id: v.vehicle_id,
    vin: v.vin,
    name: v.alias ?? v.display_name,
    display_name: v.display_name,
    model: v.model,
    type: v.car_type,
    color_og: v.color_og,
    color_og_name: v.color_og_name,
    skin_color: v.skin_color ?? v.color_og,
    state: v.state,
    location,
    speed_kmh: v.speed,
    charge: { level_pct: v.charge_level, state: v.charging_state },
    last_seen:    v.last_seen    !== null ? new Date(v.last_seen    * 1000).toISOString() : null,
    last_updated: v.last_updated !== null ? new Date(v.last_updated * 1000).toISOString() : null,
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function html(body: string, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html" } });
}

function notFound(msg = "Not found") {
  return json({ error: msg }, 404);
}

// ── Server ────────────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  routes: {
    // ── Auth ──────────────────────────────────────────────────────────────────
    "/auth": {
      GET: (req) => {
        prunePending();
        const region = new URL(req.url).searchParams.get("region") ?? "eu";
        if (!["na", "eu"].includes(region)) {
          return json({ error: "region must be 'na' or 'eu'" }, 400);
        }
        const pkce = generatePkce();
        pendingAuth.set(pkce.state, {
          codeVerifier: pkce.codeVerifier,
          region,
          expiresAt: Date.now() + 10 * 60 * 1000,
        });
        return Response.redirect(buildAuthUrl(CLIENT_ID, REDIRECT_URI, region, pkce), 302);
      },
    },

    "/callback": {
      GET: async (req) => {
        const url   = new URL(req.url);
        const error = url.searchParams.get("error");
        const state = url.searchParams.get("state");
        const code  = url.searchParams.get("code");

        if (error) {
          return html(`<h1>Authorization failed</h1><p>${error}</p>`, 400);
        }

        const session = state ? pendingAuth.get(state) : null;
        if (!session) {
          return html("<h1>Invalid or expired session</h1><p>Please try <a href='/auth'>/auth</a> again.</p>", 400);
        }
        pendingAuth.delete(state!);

        if (!code) {
          return html("<h1>No authorization code received</h1>", 400);
        }

        let tokens: any;
        try {
          tokens = await exchangeCode(code, session.codeVerifier, REDIRECT_URI, CLIENT_ID, CLIENT_SECRET);
        } catch (err) {
          return html(`<h1>Token exchange failed</h1><p>${(err as Error).message}</p>`, 500);
        }

        const { accountId, identity } = await saveAccount(db, tokens, session.region);

        return html(
          `<html><body style="font-family:sans-serif;padding:2rem;max-width:480px;margin:auto">
            <h1>✓ Account authorized</h1>
            <p><strong>Identity:</strong> ${identity}</p>
            <p><strong>Region:</strong> ${session.region}</p>
            <p><strong>Account ID:</strong> ${accountId}</p>
            <p>You can close this tab. Run <code>bun refresh.ts</code> to fetch vehicle data.</p>
          </body></html>`
        );
      },
    },

    // ── Data ──────────────────────────────────────────────────────────────────
    "/health": {
      GET: () => json({ ok: true, ts: new Date().toISOString() }),
    },

    "/accounts": {
      GET: () => {
        const accounts = db
          .query("SELECT id, email, subject, label, region, created_at FROM accounts ORDER BY id")
          .all() as Pick<Account, "id" | "email" | "subject" | "label" | "region" | "created_at">[];
        return json(accounts.map((a) => {
          const vehicles = db
            .query("SELECT vehicle_id, last_updated FROM vehicles WHERE account_id = ?")
            .all(a.id) as { vehicle_id: string; last_updated: number | null }[];
          const lastContact = vehicles.reduce((max, v) => Math.max(max, v.last_updated ?? 0), 0);
          return {
            id: a.id,
            label: a.label ?? null,
            identity: a.email ?? a.subject ?? null,
            region: a.region,
            car_count: vehicles.length,
            car_ids: vehicles.map((v) => v.vehicle_id),
            last_contact: lastContact > 0 ? new Date(lastContact * 1000).toISOString() : null,
            created_at: new Date(a.created_at * 1000).toISOString(),
          };
        }));
      },
    },

    "/vehicles": {
      GET: async () => {
        const vehicles = db.query("SELECT * FROM vehicles ORDER BY display_name").all() as Vehicle[];
        return json(await Promise.all(vehicles.map(vehicleToJson)));
      },
    },

    "/vehicles/:id": {
      GET: async (req) => {
        const v = db
          .query("SELECT * FROM vehicles WHERE vehicle_id = ?")
          .get(req.params.id) as Vehicle | null;
        if (!v) return notFound(`Vehicle '${req.params.id}' not found`);
        return json(await vehicleToJson(v));
      },
    },
  },

  fetch(req) {
    return notFound("Unknown route");
  },
});

console.log(`Tesla API server running on http://localhost:${PORT}`);
console.log(`  GET /auth          – start OAuth flow (add ?region=na for North America)`);
console.log(`  GET /callback      – OAuth callback (handled automatically)`);
console.log(`  GET /vehicles      – all cached vehicles`);
console.log(`  GET /vehicles/:id  – single vehicle`);
console.log(`  GET /accounts      – authorized accounts`);
console.log(`  GET /health        – health check`);
