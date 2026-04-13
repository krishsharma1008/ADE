import { describe, expect, it, vi, afterEach } from "vitest";
import { createConfluentClient } from "../services/confluent.js";
import type { ConfluentConfig } from "@combyne/shared";

const mockConfig: ConfluentConfig = {
  bootstrapServer: "pkc-123.us-east-1.aws.confluent.cloud:443",
  apiKey: "test-api-key",
  apiSecret: "test-api-secret",
  cluster: "lkc-abc123",
  environment: "env-xyz789",
};

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe("createConfluentClient", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("testConnection", () => {
    it("returns ok true when Confluent responds", async () => {
      global.fetch = mockFetch(200, { cluster_id: "lkc-abc123" });
      const client = createConfluentClient(mockConfig);
      const result = await client.testConnection();
      expect(result).toEqual({ ok: true, clusterId: "lkc-abc123" });
    });

    it("returns ok false on error", async () => {
      global.fetch = mockFetch(401, { error_code: 401 });
      const client = createConfluentClient(mockConfig);
      const result = await client.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("listTopics", () => {
    it("maps Confluent topic response correctly", async () => {
      global.fetch = mockFetch(200, {
        data: [
          { topic_name: "events", partitions_count: 3, replication_factor: 3 },
          { topic_name: "logs", partitions_count: 1, replication_factor: 3 },
        ],
      });
      const client = createConfluentClient(mockConfig);
      const topics = await client.listTopics();
      expect(topics).toHaveLength(2);
      expect(topics[0]).toEqual({
        name: "events",
        partitions: 3,
        replicationFactor: 3,
      });
    });
  });

  describe("createTopic", () => {
    it("sends correct payload and returns topic info", async () => {
      const fetchMock = mockFetch(201, {});
      global.fetch = fetchMock;
      const client = createConfluentClient(mockConfig);
      const topic = await client.createTopic("new-topic", 6, 3);
      expect(topic).toEqual({ name: "new-topic", partitions: 6, replicationFactor: 3 });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.topic_name).toBe("new-topic");
      expect(body.partitions_count).toBe(6);
    });
  });

  describe("deleteTopic", () => {
    it("sends DELETE request to correct URL", async () => {
      const fetchMock = mockFetch(204, undefined);
      global.fetch = fetchMock;
      const client = createConfluentClient(mockConfig);
      await client.deleteTopic("old-topic");
      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/topics/old-topic");
      expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
    });
  });

  describe("produce", () => {
    it("produces a record with key and value", async () => {
      const fetchMock = mockFetch(200, {
        topic_name: "events",
        partition_id: 0,
        offset: 42,
      });
      global.fetch = fetchMock;
      const client = createConfluentClient(mockConfig);
      const result = await client.produce("events", { foo: "bar" }, "my-key");
      expect(result).toEqual({ topic: "events", partition: 0, offset: 42 });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.key).toEqual({ type: "STRING", data: "my-key" });
      expect(body.value).toEqual({ type: "JSON", data: { foo: "bar" } });
    });

    it("produces without a key when none provided", async () => {
      const fetchMock = mockFetch(200, {
        topic_name: "events",
        partition_id: 0,
        offset: 1,
      });
      global.fetch = fetchMock;
      const client = createConfluentClient(mockConfig);
      await client.produce("events", { data: true });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.key).toBeUndefined();
    });
  });

  describe("publishEvent", () => {
    it("wraps payload in an event envelope", async () => {
      const fetchMock = mockFetch(200, {
        topic_name: "platform-events",
        partition_id: 0,
        offset: 5,
      });
      global.fetch = fetchMock;
      const client = createConfluentClient(mockConfig);
      const result = await client.publishEvent(
        "platform-events",
        "issue.created",
        "company-123",
        { issueId: "issue-456" },
      );
      expect(result.topic).toBe("platform-events");
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const envelope = body.value.data;
      expect(envelope.source).toBe("combyne");
      expect(envelope.eventType).toBe("issue.created");
      expect(envelope.companyId).toBe("company-123");
      expect(envelope.data).toEqual({ issueId: "issue-456" });
      expect(envelope.timestamp).toBeDefined();
    });
  });

  describe("authentication", () => {
    it("sends correct Basic auth header", async () => {
      const fetchMock = mockFetch(200, { data: [] });
      global.fetch = fetchMock;
      const client = createConfluentClient(mockConfig);
      await client.listTopics();
      const headers = fetchMock.mock.calls[0][1].headers;
      const expected = "Basic " + Buffer.from("test-api-key:test-api-secret").toString("base64");
      expect(headers.Authorization).toBe(expected);
    });
  });
});
