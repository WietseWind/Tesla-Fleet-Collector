#!/usr/bin/env bun
/**
 * Vehicle data refresh CLI
 * Usage: bun refresh.ts
 *
 * For each authorized account → fetches vehicle list → updates cache.
 * Vehicles are refreshed in parallel.
 * If a vehicle was last seen >10 minutes ago, sends a wake_up command first,
 * then waits for it to come online + a short settle delay before fetching data.
 */
import { getDb, upsertVehicle } from "./src/db";
import type { Account, Vehicle } from "./src/db";
import {
  getValidToken,
  listVehicles,
  getVehicleData,
  wakeUp,
  waitForOnline,
  formatCarType,
  exteriorColorToHex,
} from "./src/tesla-api";

// Converts Tesla's "R,G,B,opacity,metallic" paint_color_override to a CSS hex colour.
function paintOverrideToHex(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parts = raw.split(",").map(Number);
  if (parts.length < 3 || parts.some(isNaN)) return null;
  const [r, g, b] = parts;
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

const STALE_SECS = 10 * 60;   // 10 minutes
const SETTLE_MS  = 5_000;      // wait after wake-up before fetching data
const FORCE      = process.argv.includes("--force");
const VERBOSE    = process.argv.includes("--verbose");
const carArg     = process.argv.indexOf("--car");
const CAR_FILTER = carArg !== -1 ? process.argv[carArg + 1] : null;

const db = getDb();
const accounts = db.query("SELECT * FROM accounts").all() as Account[];

if (accounts.length === 0) {
  console.log("No accounts found. Run 'bun auth.ts' to authorize an account.");
  process.exit(0);
}

console.log(`Found ${accounts.length} account(s). Refreshing...\n`);

async function refreshVehicle(v: any, token: string, account: Account) {
  const vehicleId = String(v.id);
  const name = v.display_name ?? v.vin ?? vehicleId;
  console.log(`  Vehicle: ${name} (${vehicleId}), state=${v.state}`);

  const SKIN_COLOR_TTL = 24 * 60 * 60; // 24 hours

  const cached = db
    .query("SELECT last_seen, model, car_type, color_og, color_og_name, skin_color, skin_color_cached_at FROM vehicles WHERE vehicle_id = ?")
    .get(vehicleId) as Pick<Vehicle, "last_seen" | "model" | "car_type" | "color_og" | "color_og_name" | "skin_color" | "skin_color_cached_at"> | null;

  const now = Math.floor(Date.now() / 1000);
  const stale = FORCE || now - (cached?.last_seen ?? 0) > STALE_SECS;
  const needsConfig = !cached?.model || !cached?.car_type || !cached?.color_og;
  const needsSkinColor = FORCE || !cached?.skin_color_cached_at || now - cached.skin_color_cached_at > SKIN_COLOR_TTL;
  // Fetch vehicle_config if needed for static config OR for 24h skin colour refresh
  const fetchConfig = needsConfig || needsSkinColor;

  // Persist basic info even before fetching live data
  upsertVehicle(db, account.id, vehicleId, {
    vin: v.vin ?? null,
    display_name: v.display_name ?? null,
    state: v.state,
  });

  if (v.state !== "online") {
    if (!stale) {
      console.log(`  ${name}: ${v.state}, data fresh (<10 min) — using cache.`);
      return;
    }
    console.log(`  ${name}: ${v.state} and stale — sending wake_up...`);
    try {
      await wakeUp(token, vehicleId, account.region);
      console.log(`  ${name}: wake sent, waiting for online (up to 45s)...`);
      const online = await waitForOnline(token, vehicleId, account.region);
      if (!online) {
        console.log(`  ${name}: did not come online in time — skipping.`);
        return;
      }
      console.log(`  ${name}: online — settling ${SETTLE_MS / 1000}s before fetch...`);
      await Bun.sleep(SETTLE_MS);
    } catch (err) {
      console.error(`  ${name}: wake failed — ${(err as Error).message}`);
      return;
    }
  }

  let vehicleData: any;
  try {
    vehicleData = await getVehicleData(token, vehicleId, account.region, fetchConfig);
  } catch (err) {
    console.error(`  ${name}: failed to fetch data — ${(err as Error).message}`);
    return;
  }

  const location = vehicleData?.location_data ?? vehicleData?.drive_state ?? {};
  const drive    = vehicleData?.drive_state ?? {};
  const charge   = vehicleData?.charge_state ?? {};
  const config   = vehicleData?.vehicle_config ?? {};

  if (VERBOSE) {
    console.log(`\n  [verbose] vehicle_config for ${name}:\n${JSON.stringify(config, null, 4)}\n`);
  }

  const latitude     = location.latitude ?? null;
  const longitude    = location.longitude ?? null;
  const speedMph     = drive.speed ?? location.speed ?? null;
  const speed        = speedMph !== null ? Math.round(speedMph * 1.60934 * 10) / 10 : null;
  const chargeLevel  = charge.battery_level ?? null;
  const chargingState = charge.charging_state ?? null;
  const model        = formatCarType(config.car_type ?? null) ?? cached?.model ?? null;
  const carType      = config.trim_badging ?? cached?.car_type ?? null;
  const colorRaw     = config.exterior_color ?? null;
  const colorOg      = exteriorColorToHex(colorRaw) ?? colorRaw ?? cached?.color_og ?? null;
  const colorOgName  = colorRaw ?? cached?.color_og_name ?? null;
  // paint_color_override is "R,G,B,opacity,metallic" (0-255) — user-set in the Tesla app for wraps.
  // Only set when paint_color_override is present — null means no wrap/custom colour configured.
  const skinColor    = fetchConfig
    ? (paintOverrideToHex(config.paint_color_override) ?? null)
    : (cached?.skin_color ?? null);
  const skinColorCachedAt = fetchConfig ? now : (cached?.skin_color_cached_at ?? null);

  upsertVehicle(db, account.id, vehicleId, {
    vin: v.vin ?? null,
    display_name: v.display_name ?? null,
    model,
    car_type: carType,
    color_og: colorOg,
    color_og_name: colorOgName,
    skin_color: skinColor,
    skin_color_cached_at: skinColorCachedAt,
    state: "online",
    latitude,
    longitude,
    speed,
    charge_level: chargeLevel,
    charging_state: chargingState,
    last_seen: now,
  });

  console.log(
    `  ✓ ${name}: ${model ?? "?"} ${carType ?? ""}, ${color ?? "?"}, ` +
    `lat=${latitude?.toFixed(5)}, lon=${longitude?.toFixed(5)}, ` +
    `speed=${speed ?? 0} km/h, charge=${chargeLevel}% (${chargingState})`
  );
}

for (const account of accounts) {
  console.log(`── Account ${account.id} (${account.email ?? account.subject ?? "unknown"}, region=${account.region})`);

  let token: string;
  try {
    token = await getValidToken(account, db);
  } catch (err) {
    console.error(`  Failed to get token: ${(err as Error).message}`);
    continue;
  }

  let vehicles: any[];
  try {
    vehicles = await listVehicles(token, account.region);
  } catch (err) {
    console.error(`  Failed to list vehicles: ${(err as Error).message}`);
    continue;
  }

  const targets = CAR_FILTER ? vehicles.filter((v) => String(v.id) === CAR_FILTER) : vehicles;
  if (CAR_FILTER && targets.length === 0) {
    console.error(`  No vehicle found with id=${CAR_FILTER}`);
    continue;
  }
  console.log(`  Refreshing ${targets.length} vehicle(s) in parallel...\n`);
  await Promise.allSettled(targets.map((v) => refreshVehicle(v, token, account)));
}

console.log("\nDone.\n");
