import type { Database } from "bun:sqlite";
import { getConfig } from "./config";

// Round to 3 decimal places (~110m precision) for cache key
function key(n: number) {
  return n.toFixed(3);
}

export async function reverseGeocode(
  db: Database,
  latitude: number,
  longitude: number
): Promise<string | null> {
  const latKey = key(latitude);
  const lonKey = key(longitude);

  // Check cache first
  const cached = db
    .query("SELECT address FROM geocache WHERE lat_key = ? AND lon_key = ?")
    .get(latKey, lonKey) as { address: string } | null;

  if (cached) return cached.address;

  // Fetch from HERE v8 reverse geocoding API
  try {
    const apiKey = getConfig().here;
    if (!apiKey) return null;

    const url = `https://revgeocode.search.hereapi.com/v1/revgeocode?at=${latitude},${longitude}&apiKey=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json() as any;
    const address = data.items?.[0]?.address?.label ?? null;
    if (!address) return null;

    db.run(
      "INSERT OR REPLACE INTO geocache (lat_key, lon_key, address) VALUES (?, ?, ?)",
      [latKey, lonKey, address]
    );
    return address;
  } catch {
    return null;
  }
}
