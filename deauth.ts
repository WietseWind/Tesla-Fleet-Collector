#!/usr/bin/env bun
/**
 * Remove an authorized account by its ID.
 * Usage: bun deauth.ts --id <account_id>
 */
import { getDb } from "./src/db";

const idArg = process.argv.indexOf("--id");
if (idArg === -1 || !process.argv[idArg + 1]) {
  console.error("Usage: bun deauth.ts --id <account_id>");
  console.error("Find account IDs with: curl http://localhost:4545/accounts");
  process.exit(1);
}

const id = Number(process.argv[idArg + 1]);
if (!Number.isInteger(id) || id <= 0) {
  console.error("--id must be a positive integer");
  process.exit(1);
}

const db = getDb();
const account = db
  .query("SELECT id, email, subject, region FROM accounts WHERE id = ?")
  .get(id) as { id: number; email: string | null; subject: string | null; region: string } | null;

if (!account) {
  console.error(`No account found with id=${id}`);
  process.exit(1);
}

const identity = account.email ?? account.subject ?? "unknown";
db.run("DELETE FROM accounts WHERE id = ?", [id]);

console.log(`Removed account id=${id} (${identity}, region=${account.region})`);
console.log("Associated vehicles will be removed automatically.");
