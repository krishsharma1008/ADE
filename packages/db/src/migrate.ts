import { applyPendingMigrations, applyPendingMigrationsLocked, inspectMigrations } from "./client.js";

// `--context` targets the SHARED context DB (COMBYNE_CONTEXT_DATABASE_URL) and
// applies under an advisory lock so concurrent operator runs against the one
// shared remote DB serialize instead of racing. Without the flag, the default
// ops DB (DATABASE_URL) is migrated exactly as before.
const wantContext = process.argv.includes("--context");
const envVar = wantContext ? "COMBYNE_CONTEXT_DATABASE_URL" : "DATABASE_URL";
const url = process.env[envVar];

if (!url) {
  throw new Error(`${envVar} is required for db:migrate${wantContext ? ":context" : ""}`);
}

const before = await inspectMigrations(url);
if (before.status === "upToDate") {
  console.log("No pending migrations");
} else {
  console.log(
    `Applying ${before.pendingMigrations.length} pending migration(s) to the ${wantContext ? "context" : "ops"} DB...`,
  );
  if (wantContext) {
    await applyPendingMigrationsLocked(url);
  } else {
    await applyPendingMigrations(url);
  }

  const after = await inspectMigrations(url);
  if (after.status !== "upToDate") {
    throw new Error(`Migrations incomplete: ${after.pendingMigrations.join(", ")}`);
  }
  console.log("Migrations complete");
}
