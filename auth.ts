#!/usr/bin/env bun
/**
 * Tesla account authorization CLI
 * Usage: bun auth.ts [--region eu|na]
 */
import { getDb } from "./src/db";
import { getConfig } from "./src/config";
import { generatePkce, buildAuthUrl, exchangeCode, saveAccount } from "./src/auth-flow";

const { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } = getConfig();
const PORT = Number(process.env.PORT ?? 4545);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const regionArg = process.argv.indexOf("--region");
const region = regionArg !== -1 ? (process.argv[regionArg + 1] ?? "eu") : "eu";
if (!["na", "eu"].includes(region)) {
  console.error("--region must be 'na' or 'eu'");
  process.exit(1);
}

const pkce = generatePkce();
const authUrl = buildAuthUrl(CLIENT_ID, REDIRECT_URI, region, pkce);

console.log("\n=== Tesla Account Authorization ===\n");
console.log("Open this URL in your browser:\n");
console.log(authUrl);
console.log(`\nWaiting for callback on http://localhost:${PORT}/callback ...\n`);

// Spin up a temporary server to catch the OAuth callback
const code = await new Promise<string>((resolve, reject) => {
  let server: ReturnType<typeof Bun.serve>;
  server = Bun.serve({
    port: PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });

      const error         = url.searchParams.get("error");
      const returnedState = url.searchParams.get("state");
      const authCode      = url.searchParams.get("code");

      if (error) {
        reject(new Error(`OAuth error: ${error}`));
        server.stop(true);
        return new Response(`<h1>Error: ${error}</h1>`, { headers: { "Content-Type": "text/html" } });
      }
      if (returnedState !== pkce.state) {
        reject(new Error("State mismatch"));
        server.stop(true);
        return new Response("<h1>State mismatch</h1>", { headers: { "Content-Type": "text/html" }, status: 400 });
      }
      if (!authCode) {
        reject(new Error("No code received"));
        server.stop(true);
        return new Response("<h1>No code</h1>", { headers: { "Content-Type": "text/html" }, status: 400 });
      }

      resolve(authCode);
      server.stop(true);
      return new Response(
        `<html><body style="font-family:sans-serif;padding:2rem">
          <h1>✓ Authorization successful</h1>
          <p>You can close this tab and return to the terminal.</p>
        </body></html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    },
  });
});

console.log("Exchanging authorization code for tokens...");
const tokens = await exchangeCode(code, pkce.codeVerifier, REDIRECT_URI, CLIENT_ID, CLIENT_SECRET);

const db = getDb();
const { accountId, identity } = await saveAccount(db, tokens, region);

console.log(`\n✓ Account authorized (id=${accountId}, region=${region}, identity=${identity})`);
console.log("Run 'bun refresh.ts' to fetch vehicle data.\n");
