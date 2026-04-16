import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
 * Pick a random port in the ephemeral range. Tests create their own
 * isolated embedded Postgres instance so they never collide with a
 * running dev server on :54329.
 */
function randomPort() {
  return 55_000 + Math.floor(Math.random() * 5_000);
}

async function bootEmbeddedPostgres(): Promise<TestDbHandle> {
  const dir = await mkdtemp(path.join(tmpdir(), "combyne-test-pg-"));
  const port = randomPort();

  const mod = await import("embedded-postgres");
  const Ctor = (mod.default ?? mod) as unknown as EmbeddedPostgresCtor;
  const pg = new Ctor({
    databaseDir: dir,
    user: "combyne",
    password: "combyne",
    port,
    persistent: false,
  });

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

export async function stopTestDb() {
  const handle = sharedHandle;
  sharedHandle = null;
  startPromise = null;
  if (handle) await handle.stop();
}
