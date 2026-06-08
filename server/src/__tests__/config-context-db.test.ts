import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";

// Phase A — UI-canonical embedding config. context-database.ts writes the
// embedding block (provider/model/apiKey) into config.json via writeConfigFile;
// loadConfig must resolve it (env-wins, then config.json) so a key set in the
// Memory→Setup UI actually activates on the next restart and flips
// vectorSearchEnabled on. These tests exercise that wiring end-to-end through a
// real config.json on disk (no schema change — the bypass reader is used).

// The keys loadConfig reads (vitest.setup.ts forces them to ""). We snapshot the
// full set so a per-test override never leaks across tests.
const EMBEDDING_ENV_KEYS = [
  "COMBYNE_EMBEDDING_API_KEY",
  "EMBEDDING_API_KEY",
  "OPENAI_API_KEY",
  "COMBYNE_EMBEDDING_PROVIDER",
  "EMBEDDING_PROVIDER",
  "COMBYNE_EMBEDDING_MODEL",
  "EMBEDDING_MODEL",
  "COMBYNE_EMBEDDING_DIM",
  "EMBEDDING_DIM",
  "COMBYNE_VECTOR_SEARCH_ENABLED",
  "VECTOR_SEARCH_ENABLED",
  "COMBYNE_CONFIG",
] as const;

const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of EMBEDDING_ENV_KEYS) ORIGINAL_ENV[key] = process.env[key];

let tmpDir: string;
let configPath: string;

function writeConfigJson(value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "combyne-config-embedding-"));
  configPath = path.join(tmpDir, ".combyne", "config.json");
  // Point loadConfig at our isolated config.json (resolveCombyneConfigPath honors
  // COMBYNE_CONFIG). The sibling .env does not exist, so nothing reconciles.
  process.env.COMBYNE_CONFIG = configPath;
  // Start from a clean, key-free env so config.json is the only source. The
  // suite-wide setup sets these to "" (which `?? config.json` treats as present);
  // delete them so the env fall-through actually reaches config.json.
  for (const key of EMBEDDING_ENV_KEYS) {
    if (key === "COMBYNE_CONFIG") continue;
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of EMBEDDING_ENV_KEYS) {
    const original = ORIGINAL_ENV[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadConfig — UI-saved embedding block (config.json, no key env)", () => {
  it("resolves the embedding block from config.json (provider/model/dim/key)", () => {
    writeConfigJson({
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-large",
      embeddingApiKey: "sk-config-json-key",
      embeddingDim: 3072,
      embeddingDisclosureAcked: true,
    });

    const config = loadConfig();

    expect(config.embeddingApiKey).toBe("sk-config-json-key");
    expect(config.embeddingProvider).toBe("openai");
    expect(config.embeddingModel).toBe("text-embedding-3-large");
    expect(config.embeddingDim).toBe(3072);
  });

  it("flips vectorSearchEnabled on once the config.json key resolves (flag set, no key env)", () => {
    // The existing coercion is a two-part gate: the flag expresses intent, the
    // resolved key flips it on. With the flag on and ONLY a config.json key
    // (no key env), the UI-saved key must satisfy the key half of the gate.
    process.env.COMBYNE_VECTOR_SEARCH_ENABLED = "true";
    writeConfigJson({
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      embeddingApiKey: "sk-config-json-key",
    });

    const config = loadConfig();

    expect(config.embeddingApiKey).toBe("sk-config-json-key");
    expect(config.vectorSearchEnabled).toBe(true);
  });

  it("enables vectorSearchEnabled from a config.json key alone, with NO env flag (CFG-1, UI-canonical)", () => {
    // The exact Memory→Setup scenario: operator saved a key via the UI, never
    // touched any env var. beforeEach already deleted COMBYNE_VECTOR_SEARCH_ENABLED,
    // so the flag is genuinely unset — the key alone must turn vector search on.
    expect(process.env.COMBYNE_VECTOR_SEARCH_ENABLED).toBeUndefined();
    writeConfigJson({
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      embeddingApiKey: "sk-config-json-key",
    });

    const config = loadConfig();

    expect(config.embeddingApiKey).toBe("sk-config-json-key");
    expect(config.vectorSearchEnabled).toBe(true);
  });

  it("kill-switch: COMBYNE_VECTOR_SEARCH_ENABLED=false forces hash-64 even WITH a key (CFG-1)", () => {
    process.env.COMBYNE_VECTOR_SEARCH_ENABLED = "false";
    writeConfigJson({
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      embeddingApiKey: "sk-config-json-key",
    });

    const config = loadConfig();

    expect(config.embeddingApiKey).toBe("sk-config-json-key");
    expect(config.vectorSearchEnabled).toBe(false);
  });

  it("leaves vectorSearchEnabled false and key empty when config.json has no embedding block", () => {
    process.env.COMBYNE_VECTOR_SEARCH_ENABLED = "true";
    writeConfigJson({ someOtherKey: "value" });

    const config = loadConfig();

    expect(config.embeddingApiKey).toBe("");
    // No resolved key → coerced OFF even with the flag set (no-egress invariant).
    expect(config.vectorSearchEnabled).toBe(false);
    // Defaults survive when neither env nor config.json provide them.
    expect(config.embeddingProvider).toBe("openai");
    expect(config.embeddingModel).toBe("text-embedding-3-small");
    expect(config.embeddingDim).toBe(1536);
  });

  it("ignores an empty-string embeddingApiKey in config.json (stays disabled)", () => {
    process.env.COMBYNE_VECTOR_SEARCH_ENABLED = "true";
    writeConfigJson({
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      embeddingApiKey: "",
    });

    const config = loadConfig();

    expect(config.embeddingApiKey).toBe("");
    expect(config.vectorSearchEnabled).toBe(false);
  });
});

describe("loadConfig — env wins over the config.json embedding block", () => {
  it("EMBEDDING_API_KEY env overrides the config.json key", () => {
    writeConfigJson({
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-large",
      embeddingApiKey: "sk-config-json-key",
      embeddingDim: 3072,
    });
    process.env.COMBYNE_VECTOR_SEARCH_ENABLED = "true";
    process.env.COMBYNE_EMBEDDING_API_KEY = "sk-env-wins";
    process.env.COMBYNE_EMBEDDING_PROVIDER = "azure-openai";
    process.env.COMBYNE_EMBEDDING_MODEL = "env-model";
    process.env.COMBYNE_EMBEDDING_DIM = "256";

    const config = loadConfig();

    expect(config.embeddingApiKey).toBe("sk-env-wins");
    expect(config.embeddingProvider).toBe("azure-openai");
    expect(config.embeddingModel).toBe("env-model");
    expect(config.embeddingDim).toBe(256);
    expect(config.vectorSearchEnabled).toBe(true);
  });

  it("OPENAI_API_KEY env takes precedence over the config.json key", () => {
    process.env.COMBYNE_VECTOR_SEARCH_ENABLED = "true";
    writeConfigJson({ embeddingApiKey: "sk-config-json-key" });
    process.env.OPENAI_API_KEY = "sk-openai-env-wins";

    const config = loadConfig();

    expect(config.embeddingApiKey).toBe("sk-openai-env-wins");
    expect(config.vectorSearchEnabled).toBe(true);
  });
});

describe("loadConfig — key INTENT gates egress (P1: generic OPENAI_API_KEY ≠ opt-in)", () => {
  it("a generic OPENAI_API_KEY alone (no flag) does NOT enable vector search / egress", () => {
    // The exact risk: a host has OPENAI_API_KEY for the summarizer; it must not
    // silently turn on remote embedding of memory bodies.
    expect(process.env.COMBYNE_VECTOR_SEARCH_ENABLED).toBeUndefined();
    process.env.OPENAI_API_KEY = "sk-generic-host-key";

    const config = loadConfig();

    expect(config.embeddingApiKey).toBe("sk-generic-host-key"); // resolved (usable IF enabled)…
    expect(config.vectorSearchEnabled).toBe(false); // …but NOT enabled without explicit intent
  });

  it("a generic OPENAI_API_KEY WITH explicit COMBYNE_VECTOR_SEARCH_ENABLED=true enables it", () => {
    process.env.OPENAI_API_KEY = "sk-generic-host-key";
    process.env.COMBYNE_VECTOR_SEARCH_ENABLED = "true";

    const config = loadConfig();

    expect(config.vectorSearchEnabled).toBe(true);
  });

  it("the DEDICATED COMBYNE_EMBEDDING_API_KEY alone (no flag) IS embedding intent → enabled", () => {
    expect(process.env.COMBYNE_VECTOR_SEARCH_ENABLED).toBeUndefined();
    process.env.COMBYNE_EMBEDDING_API_KEY = "sk-dedicated-embedding-key";

    const config = loadConfig();

    expect(config.embeddingApiKey).toBe("sk-dedicated-embedding-key");
    expect(config.vectorSearchEnabled).toBe(true);
  });

  it("the kill-switch still wins over a dedicated key", () => {
    process.env.COMBYNE_EMBEDDING_API_KEY = "sk-dedicated-embedding-key";
    process.env.COMBYNE_VECTOR_SEARCH_ENABLED = "false";

    const config = loadConfig();

    expect(config.vectorSearchEnabled).toBe(false);
  });
});
