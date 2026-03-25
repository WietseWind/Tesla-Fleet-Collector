import { Database } from "bun:sqlite";

export interface Account {
  id: number;
  email: string | null;
  subject: string | null;
  label: string | null;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  region: string;
  created_at: number;
}

export interface Vehicle {
  id: number;
  account_id: number;
  vehicle_id: string;
  vin: string | null;
  display_name: string | null;
  alias: string | null;
  model: string | null;
  car_type: string | null;
  color: string | null;
  skin_color: string | null;
  skin_color_cached_at: number | null;
  latitude: number | null;
  longitude: number | null;
  speed: number | null;
  charge_level: number | null;
  charging_state: string | null;
  state: string | null;
  last_seen: number | null;
  last_updated: number | null;
}

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  _db = new Database("./tesla.db");
  _db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  initSchema(_db);
  return _db;
}

function initSchema(db: Database) {
  // Migrate existing DBs
  try { db.exec("ALTER TABLE accounts ADD COLUMN subject TEXT"); } catch {}
  try { db.exec("ALTER TABLE accounts ADD COLUMN label TEXT"); } catch {}
  try { db.exec("ALTER TABLE vehicles ADD COLUMN alias TEXT"); } catch {}
  try { db.exec("ALTER TABLE vehicles ADD COLUMN model TEXT"); } catch {}
  try { db.exec("ALTER TABLE vehicles ADD COLUMN car_type TEXT"); } catch {}
  try { db.exec("ALTER TABLE vehicles ADD COLUMN color TEXT"); } catch {}
  try { db.exec("ALTER TABLE vehicles ADD COLUMN skin_color TEXT"); } catch {}
  try { db.exec("ALTER TABLE vehicles ADD COLUMN skin_color_cached_at INTEGER"); } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT,
      subject       TEXT,
      label         TEXT,
      access_token  TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at    INTEGER NOT NULL,
      region        TEXT NOT NULL DEFAULT 'eu',
      created_at    INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS geocache (
      lat_key   TEXT NOT NULL,
      lon_key   TEXT NOT NULL,
      address   TEXT NOT NULL,
      cached_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (lat_key, lon_key)
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      vehicle_id     TEXT NOT NULL UNIQUE,
      vin            TEXT,
      display_name   TEXT,
      alias          TEXT,
      model          TEXT,
      car_type       TEXT,
      color          TEXT,
      skin_color             TEXT,
      skin_color_cached_at   INTEGER,
      latitude       REAL,
      longitude      REAL,
      speed          REAL,
      charge_level   INTEGER,
      charging_state TEXT,
      state          TEXT,
      last_seen      INTEGER,
      last_updated   INTEGER
    );
  `);
}

export function upsertVehicle(
  db: Database,
  accountId: number,
  vehicleId: string,
  fields: Partial<Omit<Vehicle, "id" | "account_id" | "vehicle_id">>
) {
  const existing = db
    .query("SELECT id FROM vehicles WHERE vehicle_id = ?")
    .get(vehicleId);

  if (!existing) {
    db.run(
      `INSERT INTO vehicles (account_id, vehicle_id, vin, display_name, latitude, longitude,
        speed, charge_level, charging_state, state, last_seen, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        accountId,
        vehicleId,
        fields.vin ?? null,
        fields.display_name ?? null,
        fields.latitude ?? null,
        fields.longitude ?? null,
        fields.speed ?? null,
        fields.charge_level ?? null,
        fields.charging_state ?? null,
        fields.state ?? null,
        fields.last_seen ?? null,
        fields.last_updated ?? Math.floor(Date.now() / 1000),
      ]
    );
  } else {
    const sets = Object.entries(fields)
      .map(([k]) => `${k} = ?`)
      .join(", ");
    const vals = Object.values(fields);
    db.run(
      `UPDATE vehicles SET ${sets}, last_updated = ? WHERE vehicle_id = ?`,
      [...vals, Math.floor(Date.now() / 1000), vehicleId]
    );
  }
}
