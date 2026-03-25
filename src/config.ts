import { join } from "path";

interface ApiConfig {
  client_id: string;
  client_secret?: string;
  here?: string;
  home?: { latitude: number; longitude: number };
}

let _config: ApiConfig | null = null;

export function getConfig(): ApiConfig {
  if (_config) return _config;
  const path = join(import.meta.dir, "../apiconfig.json");
  const file = Bun.file(path);
  if (!file.size) throw new Error("apiconfig.json not found");
  _config = require(path) as ApiConfig;
  if (!_config.client_id) throw new Error("apiconfig.json missing client_id");
  return _config;
}
