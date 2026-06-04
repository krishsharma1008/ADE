import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { createDb, migratePostgresIfEmpty, type Db } from "@combyne/db";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
}) => EmbeddedPostgresInstance;

export interface TestDbHandle {
  db: Db;
  connectionString: string;
  stop: () => Promise<void>;
}

let sharedHandle: TestDbHandle | null = null;
let startPromise: Promise<TestDbHandle> | null = null;

/**
 * Ask the OS for a currently-free TCP port on the loopback interface.
 *
 * Each test file boots its own isolated embedded Postgres, and vitest runs
 * files concurrently across workers. The previous `55_000 + random(5_000)`
 * scheme collided (birthday paradox) under that concurrency, surfacing as a
 * suite-level "Unknown Error: undefined" when two instances raced for the same
 * port. Binding port 0 and reading back the assigned port eliminates collisions
 * at selection time; the small TOCTOU window between close() and Postgres
 * binding is covered by the retry loop in bootEmbeddedPostgres().
 */
async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else if (port) resolve(port);
        else reject(new Error("could not determine a free port"));
      });
    });
  });
}

async function bootOnce(): Promise<TestDbHandle> {
  const dir = await mkdtemp(path.join(tmpdir(), "combyne-test-pg-"));
  const port = await findFreePort();

  const mod = await import("embedded-postgres");
  const Ctor = (mod.default ?? mod) as unknown as EmbeddedPostgresCtor;
  const pg = new Ctor({
    databaseDir: dir,
    user: "combyne",
    password: "combyne",
    port,
    persistent: false,
  });

  const cleanup = async () => {
    await pg.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://combyne:combyne@127.0.0.1:${port}/postgres`;
    await migratePostgresIfEmpty(connectionString);
    const db = createDb(connectionString);
    return {
      db,
      connectionString,
      stop: async () => {
        try {
          await pg.stop();
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      },
    };
  } catch (err) {
    // Clean up the half-booted instance before the caller retries on a fresh
    // port/dir, so a transient boot failure or port race never leaks resources.
    await cleanup();
    throw err;
  }
}

async function bootEmbeddedPostgres(): Promise<TestDbHandle> {
  const maxAttempts = 5;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await bootOnce();
    } catch (err) {
      lastErr = err;
      // Backoff with jitter, then retry on a freshly probed port + temp dir.
      await new Promise((r) => setTimeout(r, 100 * attempt + Math.floor(Math.random() * 100)));
    }
  }
  const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`embedded Postgres failed to boot after ${maxAttempts} attempts: ${message}`);
}

export async function startTestDb(): Promise<TestDbHandle> {
  if (sharedHandle) return sharedHandle;
  if (startPromise) return startPromise;
  startPromise = bootEmbeddedPostgres().then((h) => {
    sharedHandle = h;
    return h;
  });
  return startPromise;
}

/**
 * Boot a fresh, independent embedded Postgres (NOT the shared singleton). Used
 * by tests that need a SECOND physical database in the same process — e.g. the
 * separate dedicated context DB. The caller owns the returned handle and must
 * call `handle.stop()` itself; `stopTestDb()` only tears down the singleton.
 */
export async function startIsolatedTestDb(): Promise<TestDbHandle> {
  return bootEmbeddedPostgres();
}

export async function stopTestDb() {
  const handle = sharedHandle;
  sharedHandle = null;
  startPromise = null;
  if (handle) await handle.stop();
}
