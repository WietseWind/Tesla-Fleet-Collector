#!/usr/bin/env bun
/**
 * Set a human-friendly label on an account.
 * Usage: bun account.ts <email|subject|id> --label <alias>
 *
 * Examples:
 *   bun account.ts user@example.com --label "Work"
 *   bun account.ts 1 --label "Personal"
 */
import { getDb } from "./src/db";
import type { Account } from "./src/db";

const labelArg = process.argv.indexOf("--label");
if (labelArg === -1 || !process.argv[labelArg + 1]) {
  console.error("Usage: bun account.ts <email|subject|id> --label <alias>");
  process.exit(1);
}

const identity = process.argv[2];
if (!identity || identity.startsWith("--")) {
  console.error("Usage: bun account.ts <email|subject|id> --label <alias>");
  process.exit(1);
}

const label = process.argv[labelArg + 1];
const db = getDb();

// Match by numeric ID, email, or subject
const account = (
  db.query("SELECT * FROM accounts WHERE id = ? OR email = ? OR subject = ?")
    .get(Number(identity) || -1, identity, identity) as Account | null
);

if (!account) {
  console.error(`No account found matching '${identity}'`);
  console.error("Run: curl http://localhost:4545/accounts  to list accounts");
  process.exit(1);
}

db.run("UPDATE accounts SET label = ? WHERE id = ?", [label, account.id]);

const display = account.email ?? account.subject ?? String(account.id);
console.log(`✓ Account ${account.id} (${display}) labelled: "${label}"`);
