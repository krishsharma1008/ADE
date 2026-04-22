import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetCacheTracker,
  trackCachePrefixHit,
} from "../context-budget-telemetry.js";

describe("trackCachePrefixHit", () => {
  beforeEach(() => {
    _resetCacheTracker();
  });

  it("returns miss with null previousHash on first call", () => {
    const r = trackCachePrefixHit("agent-a", "hash-1");
    expect(r.hit).toBe(false);
    expect(r.previousHash).toBeNull();
  });

  it("returns hit when the same hash is seen twice in a row", () => {
    trackCachePrefixHit("agent-a", "hash-1");
    const r = trackCachePrefixHit("agent-a", "hash-1");
    expect(r.hit).toBe(true);
    expect(r.previousHash).toBe("hash-1");
  });

  it("returns miss + populated previousHash when the hash changes", () => {
    trackCachePrefixHit("agent-a", "hash-1");
    const r = trackCachePrefixHit("agent-a", "hash-2");
    expect(r.hit).toBe(false);
    expect(r.previousHash).toBe("hash-1");
  });

  it("scopes state per-agent", () => {
    trackCachePrefixHit("agent-a", "hash-1");
    const r = trackCachePrefixHit("agent-b", "hash-1");
    expect(r.hit).toBe(false);
    expect(r.previousHash).toBeNull();
  });

  it("treats empty or nullish current hash as miss and leaves the previous value alone", () => {
    trackCachePrefixHit("agent-a", "hash-1");
    const r1 = trackCachePrefixHit("agent-a", null);
    expect(r1.hit).toBe(false);
    expect(r1.previousHash).toBe("hash-1");
    // Previous value survives — next real hash still matches it.
    const r2 = trackCachePrefixHit("agent-a", "hash-1");
    expect(r2.hit).toBe(true);
    expect(r2.previousHash).toBe("hash-1");
  });

  it("_resetCacheTracker clears state so the next call is a miss", () => {
    trackCachePrefixHit("agent-a", "hash-1");
    _resetCacheTracker();
    const r = trackCachePrefixHit("agent-a", "hash-1");
    expect(r.hit).toBe(false);
    expect(r.previousHash).toBeNull();
  });
});
