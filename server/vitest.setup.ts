// Test determinism: force the hash-64 embedding ORACLE for the whole server suite,
// regardless of any developer `.env` (or instance `.env`) that enables the managed
// embedder for `pnpm dev`. The suite's embedding assertions (embedding_version =
// 'hash-64:64', the version-guard, retrieval-quality bands) rely on the deterministic
// hash path; the live tier is opted into explicitly by the eval scripts via
// COMBYNE_EVAL_LIVE_EMBEDDINGS and never by the unit suite.
//
// We SET to "" (not delete): config.ts loads dotenv with { override: false }, so a
// value that is already present (even empty) is left as-is and the real key in .env
// can't re-populate it. Result: embeddingApiKey === "" → embedder disabled → hash-64.
import os from "node:os";
import path from "node:path";

process.env.COMBYNE_VECTOR_SEARCH_ENABLED = "";
process.env.COMBYNE_EMBEDDING_API_KEY = "";
process.env.EMBEDDING_API_KEY = "";
process.env.OPENAI_API_KEY = "";

// Test determinism #2: force SINGLE-DB mode for the whole suite. A developer
// `.env` / instance `.env` / instance `config.json` may set
// COMBYNE_CONTEXT_DATABASE_URL to a real REMOTE context DB (e.g. Cloud SQL) for
// `pnpm dev`. If that leaks into the suite, resolveContextDb() routes every
// memory/context query to that shared remote DB — contaminating tests with
// foreign data, hitting pgvector when the embedded rig has none, and making the
// suite non-deterministic/network-dependent.
//
// Clearing the env var alone is NOT enough: config.ts also (a) reconciles from the
// instance `.env` FILE and (b) falls back to the instance `config.json`. So we also
// point COMBYNE_CONFIG at an ISOLATED, non-existent path: resolveCombyneConfigPath
// honors it, resolveCombyneEnvPath derives the `.env` beside it, and neither file
// exists → no config.json fallback and no `.env` reconcile. Net:
// resolveContextDbUrl() === "" → resolveContextDb(db) === db (the embedded test PG).
process.env.COMBYNE_CONTEXT_DATABASE_URL = "";
process.env.CONTEXT_DATABASE_URL = "";
process.env.COMBYNE_CONFIG = path.join(os.tmpdir(), "combyne-vitest-isolated", "config.json");
