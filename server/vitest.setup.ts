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
process.env.COMBYNE_VECTOR_SEARCH_ENABLED = "";
process.env.COMBYNE_EMBEDDING_API_KEY = "";
process.env.EMBEDDING_API_KEY = "";
process.env.OPENAI_API_KEY = "";
