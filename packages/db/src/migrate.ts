import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { requireDatabaseUrl } from "./env";
import { describeError } from "./safe-error";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_FOLDER = resolve(here, "../drizzle");

export async function runMigrations(url = requireDatabaseUrl()): Promise<void> {
  const sql = postgres(url, { max: 1 });
  try {
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await sql.end();
  }
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  runMigrations()
    .then(() => {
      console.log("migrations applied");
    })
    .catch((err) => {
      // The driver's message carries the failed SQL; only its kind and code are logged.
      console.error(`migrations failed: ${describeError("migrate", err)}`);
      process.exit(1);
    });
}
