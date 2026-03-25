import type { Database } from "bun:sqlite";
import type { Account } from "./db";
import { getConfig } from "./config";

const FLEET_BASE: Record<string, string> = {
  na: "https://fleet-api.prd.na.vn.cloud.tesla.com",
  eu: "https://fleet-api.prd.eu.vn.cloud.tesla.com",
};
const AUTH_URL = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";

export function fleetBase(region = "eu") {
  return FLEET_BASE[region] ?? FLEET_BASE.eu;
}

async function apiFetch(url: string, token: string, opts: RequestInit = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Tesla API ${res.status}: ${body}`);
  }
  return res.json() as Promise<any>;
}

// ── Token management ─────────────────────────────────────────────────────────

async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret?: string
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  };
  if (clientSecret) body.client_secret = clientSecret;

  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  return res.json();
}

export async function getValidToken(account: Account, db: Database): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const { client_id: clientId, client_secret: clientSecret } = getConfig();

  // Refresh if expiring within 5 minutes
  if (account.expires_at - now < 300) {
    console.log(`Refreshing token for account ${account.id} (${account.email ?? "unknown"})...`);
    const tokens = await refreshAccessToken(account.refresh_token, clientId, clientSecret);
    const expiresAt = now + tokens.expires_in;
    db.run(
      "UPDATE accounts SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = ?",
      [tokens.access_token, tokens.refresh_token, expiresAt, account.id]
    );
    return tokens.access_token;
  }

  return account.access_token;
}

// ── Vehicle API ───────────────────────────────────────────────────────────────

export async function listVehicles(token: string, region = "eu") {
  const data = await apiFetch(`${fleetBase(region)}/api/1/vehicles`, token);
  return data.response as any[];
}

export async function getVehicleData(
  token: string,
  vehicleId: string,
  region = "eu",
  includeConfig = false
) {
  // vehicle_state is intentionally excluded — car state comes from listVehicles.
  // vehicle_config is static (model/trim/colour never change) so only fetched when not yet cached.
  const endpoints = ["location_data", "charge_state", "drive_state"];
  if (includeConfig) endpoints.push("vehicle_config");

  const data = await apiFetch(
    `${fleetBase(region)}/api/1/vehicles/${vehicleId}/vehicle_data?endpoints=${encodeURIComponent(endpoints.join(";"))}`,
    token
  );
  return data.response;
}

const CAR_TYPE_LABELS: Record<string, string> = {
  models:      "Model S",
  modelx:      "Model X",
  model3:      "Model 3",
  modely:      "Model Y",
  cybertruck:  "Cybertruck",
  semi:        "Semi",
  roadster:    "Roadster",
};

export function formatCarType(carType: string | null): string | null {
  if (!carType) return null;
  return CAR_TYPE_LABELS[carType.toLowerCase()] ?? carType;
}

export async function wakeUp(token: string, vehicleId: string, region = "eu") {
  const data = await apiFetch(
    `${fleetBase(region)}/api/1/vehicles/${vehicleId}/wake_up`,
    token,
    { method: "POST" }
  );
  return data.response;
}

export async function getVehicleState(token: string, vehicleId: string, region = "eu") {
  const vehicles = await listVehicles(token, region);
  return vehicles.find((v) => String(v.id) === String(vehicleId));
}

// Poll until the vehicle comes online (or timeout)
export async function waitForOnline(
  token: string,
  vehicleId: string,
  region = "eu",
  timeoutMs = 45_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await getVehicleState(token, vehicleId, region);
    if (v?.state === "online") return true;
    await Bun.sleep(3000);
  }
  return false;
}
