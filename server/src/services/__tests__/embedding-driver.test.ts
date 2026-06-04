import { afterEach, describe, expect, it, vi } from "vitest";
import { makeEmbeddingDriver } from "../embedding-driver.js";

const BASE = {
  apiKey: "sk-test-key",
  provider: "openai",
  model: "text-embedding-3-small",
  dim: 4,
};

function vec(n: number): number[] {
  return new Array(n).fill(0).map((_, i) => (i === 0 ? 1 : 0));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("embedding-driver", () => {
  it("version is `${provider}:${model}:${dim}`", () => {
    const d = makeEmbeddingDriver(BASE);
    expect(d.version).toBe("openai:text-embedding-3-small:4");
  });

  it("POSTs the batch and returns ordered vectors", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { index: 1, embedding: vec(4) },
          { index: 0, embedding: vec(4) },
        ],
        usage: { prompt_tokens: 7 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const d = makeEmbeddingDriver(BASE);
    const r = await d.embed(["a", "b"]);
    expect(r.vectors.length).toBe(2);
    expect(r.inputTokens).toBe(7);
    expect(r.version).toBe("openai:text-embedding-3-small:4");
    // Authorization header carries the bearer key; body carries model + input.
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).authorization).toContain("sk-test-key");
    expect(JSON.parse(init.body as string)).toEqual({ model: BASE.model, input: ["a", "b"] });
  });

  it("THROWS on a dim mismatch (never writes a wrong-width vector)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ index: 0, embedding: vec(8) }] }), // dim 8 != 4
      }),
    );
    const d = makeEmbeddingDriver(BASE);
    await expect(d.embed(["a"])).rejects.toThrow(/embedding_dim_mismatch/);
  });

  it("wraps a non-ok HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "rate limited" }),
    );
    const d = makeEmbeddingDriver(BASE);
    await expect(d.embed(["a"])).rejects.toThrow(/embedding_http_429/);
  });

  it("throws a clear error when no key resolves anywhere", async () => {
    const prevA = process.env.COMBYNE_EMBEDDING_API_KEY;
    const prevB = process.env.OPENAI_API_KEY;
    delete process.env.COMBYNE_EMBEDDING_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const d = makeEmbeddingDriver({ ...BASE, apiKey: null });
      await expect(d.embed(["a"])).rejects.toThrow(/requires an API key/);
    } finally {
      if (prevA !== undefined) process.env.COMBYNE_EMBEDDING_API_KEY = prevA;
      if (prevB !== undefined) process.env.OPENAI_API_KEY = prevB;
    }
  });

  it("returns empty for an empty input without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const d = makeEmbeddingDriver(BASE);
    const r = await d.embed([]);
    expect(r.vectors).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
