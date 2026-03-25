import crypto from "crypto";
import type { Database } from "bun:sqlite";
import { fleetBase } from "./tesla-api";

export const SCOPES =
  "openid offline_access user_data vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds";

const AUTH_BASE = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3";

// ── PKCE ─────────────────────────────────────────────────────────────────────

function b64url(buf: Buffer) {
  return buf.toString("base64url");
}

export function generatePkce() {
  const codeVerifier  = b64url(crypto.randomBytes(32));
  const codeChallenge = b64url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state         = crypto.randomBytes(16).toString("hex");
  return { codeVerifier, codeChallenge, state };
}

// ── Auth URL ──────────────────────────────────────────────────────────────────

export function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  region: string,
  pkce: ReturnType<typeof generatePkce>
): string {
  const url = new URL(`${AUTH_BASE}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", pkce.state);
  url.searchParams.set("code_challenge", pkce.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// ── Token exchange ────────────────────────────────────────────────────────────

export async function exchangeCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  clientId: string,
  clientSecret?: string
) {
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return res.json() as Promise<any>;
}

// ── Identity ──────────────────────────────────────────────────────────────────

function jwtPayload(token: string): Record<string, any> {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  } catch {
    return {};
  }
}

export async function fetchIdentity(
  accessToken: string,
  region: string
): Promise<{ email: string | null; subject: string | null }> {
  const claims = jwtPayload(accessToken);
  let email:   string | null = claims.email ?? null;
  let subject: string | null = claims.sub   ?? null;

  try {
    const res = await fetch(`${fleetBase(region)}/api/1/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = await res.json() as any;
    if (res.ok) {
      email   = body.response?.email ?? email;
      subject = body.response?.uid ?? body.response?.id ?? subject;
    }
  } catch {
    // non-fatal — JWT claims are the fallback
  }

  return { email, subject };
}

// ── Save to DB ────────────────────────────────────────────────────────────────

export async function saveAccount(
  db: Database,
  tokens: any,
  region: string
): Promise<{ accountId: number | bigint; identity: string }> {
  const expiresAt = Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 28800);
  const { email, subject } = await fetchIdentity(tokens.access_token, region);

  // Check if this identity already exists — match on subject (uid) or email
  const existing = db.query(
    "SELECT id FROM accounts WHERE (subject IS NOT NULL AND subject = ?) OR (email IS NOT NULL AND email = ?)"
  ).get(subject, email) as { id: number } | null;

  if (existing) {
    // Update tokens only — preserve id, label, and everything else
    db.run(
      "UPDATE accounts SET access_token = ?, refresh_token = ?, expires_at = ?, email = ?, subject = ? WHERE id = ?",
      [tokens.access_token, tokens.refresh_token, expiresAt, email, subject, existing.id]
    );
    return { accountId: existing.id, identity: email ?? subject ?? "unknown" };
  }

  const insert = db.run(
    "INSERT INTO accounts (access_token, refresh_token, expires_at, region, email, subject) VALUES (?, ?, ?, ?, ?, ?)",
    [tokens.access_token, tokens.refresh_token, expiresAt, region, email, subject]
  );
  return { accountId: insert.lastInsertRowid, identity: email ?? subject ?? "unknown" };
}
