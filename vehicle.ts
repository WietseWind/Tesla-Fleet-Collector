#!/usr/bin/env bun
/**
 * Set a human-friendly alias on a vehicle.
 * Usage: bun vehicle.ts <vehicle_id> --alias <name>
 *
 * Examples:
 *   bun vehicle.ts 1234567890123456 --alias "Daily Driver"
 */
import { getDb } from "./src/db";
import type { Vehicle } from "./src/db";

const aliasArg = process.argv.indexOf("--alias");
if (aliasArg === -1 || !process.argv[aliasArg + 1]) {
  console.error("Usage: bun vehicle.ts <vehicle_id> --alias <name>");
  process.exit(1);
}

const vehicleId = process.argv[2];
if (!vehicleId || vehicleId.startsWith("--")) {
  console.error("Usage: bun vehicle.ts <vehicle_id> --alias <name>");
  process.exit(1);
}

const alias = process.argv[aliasArg + 1];
const db = getDb();

const vehicle = db
  .query("SELECT * FROM vehicles WHERE vehicle_id = ?")
  .get(vehicleId) as Vehicle | null;

if (!vehicle) {
  console.error(`No vehicle found with id='${vehicleId}'`);
  console.error("Run: curl http://localhost:4545/vehicles  to list vehicles");
  process.exit(1);
}

db.run("UPDATE vehicles SET alias = ? WHERE vehicle_id = ?", [alias, vehicleId]);

const display = vehicle.display_name ?? vehicle.vin ?? vehicleId;
console.log(`✓ Vehicle ${vehicleId} (${display}) aliased: "${alias}"`);
