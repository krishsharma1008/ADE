import { describe, expect, it } from "vitest";
import {
  jiraConfigSchema,
  confluentConfigSchema,
  createIntegrationSchema,
  updateIntegrationSchema,
  jiraSyncIssuesSchema,
  confluentProduceSchema,
  confluentCreateTopicSchema,
} from "@combyne/shared";

describe("jiraConfigSchema", () => {
  it("accepts valid Jira config", () => {
    const result = jiraConfigSchema.safeParse({
      baseUrl: "https://mycompany.atlassian.net",
      email: "user@example.com",
      apiToken: "abc123",
      projectKey: "PROJ",
    });
    expect(result.success).toBe(true);
  });

  it("rejects trailing slash in baseUrl", () => {
    const result = jiraConfigSchema.safeParse({
      baseUrl: "https://mycompany.atlassian.net/",
      email: "user@example.com",
      apiToken: "abc123",
      projectKey: "PROJ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid email", () => {
    const result = jiraConfigSchema.safeParse({
      baseUrl: "https://mycompany.atlassian.net",
      email: "not-an-email",
      apiToken: "abc123",
      projectKey: "PROJ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty apiToken", () => {
    const result = jiraConfigSchema.safeParse({
      baseUrl: "https://mycompany.atlassian.net",
      email: "user@example.com",
      apiToken: "",
      projectKey: "PROJ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects projectKey longer than 10 chars", () => {
    const result = jiraConfigSchema.safeParse({
      baseUrl: "https://mycompany.atlassian.net",
      email: "user@example.com",
      apiToken: "token",
      projectKey: "TOOLONGKEY1",
    });
    expect(result.success).toBe(false);
  });
});

describe("confluentConfigSchema", () => {
  it("accepts valid Confluent config", () => {
    const result = confluentConfigSchema.safeParse({
      bootstrapServer: "pkc-123.us-east-1.aws.confluent.cloud:443",
      apiKey: "my-key",
      apiSecret: "my-secret",
      cluster: "lkc-abc",
      environment: "env-xyz",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty required fields", () => {
    const result = confluentConfigSchema.safeParse({
      bootstrapServer: "",
      apiKey: "key",
      apiSecret: "secret",
      cluster: "cluster",
      environment: "env",
    });
    expect(result.success).toBe(false);
  });
});

describe("createIntegrationSchema", () => {
  it("accepts valid jira integration", () => {
    const result = createIntegrationSchema.safeParse({
      provider: "jira",
      config: {
        baseUrl: "https://test.atlassian.net",
        email: "user@test.com",
        apiToken: "token",
        projectKey: "TEST",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid confluent integration", () => {
    const result = createIntegrationSchema.safeParse({
      provider: "confluent",
      config: {
        bootstrapServer: "server:443",
        apiKey: "key",
        apiSecret: "secret",
        cluster: "cluster",
        environment: "env",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects mismatched provider and config", () => {
    const result = createIntegrationSchema.safeParse({
      provider: "jira",
      config: {
        bootstrapServer: "server:443",
        apiKey: "key",
        apiSecret: "secret",
        cluster: "cluster",
        environment: "env",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown provider", () => {
    const result = createIntegrationSchema.safeParse({
      provider: "slack",
      config: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("updateIntegrationSchema", () => {
  it("accepts enabled-only update", () => {
    const result = updateIntegrationSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
  });

  it("accepts config-only update", () => {
    const result = updateIntegrationSchema.safeParse({
      config: {
        baseUrl: "https://new.atlassian.net",
        email: "user@test.com",
        apiToken: "new-token",
        projectKey: "NEW",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty update", () => {
    const result = updateIntegrationSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("jiraSyncIssuesSchema", () => {
  it("accepts empty body (defaults)", () => {
    const result = jiraSyncIssuesSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts valid jql and maxResults", () => {
    const result = jiraSyncIssuesSchema.safeParse({
      jql: "project = TEST",
      maxResults: 50,
    });
    expect(result.success).toBe(true);
  });

  it("rejects maxResults > 100", () => {
    const result = jiraSyncIssuesSchema.safeParse({ maxResults: 101 });
    expect(result.success).toBe(false);
  });
});

describe("confluentProduceSchema", () => {
  it("accepts valid produce request", () => {
    const result = confluentProduceSchema.safeParse({
      topic: "my-topic",
      value: { event: "test" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts produce with key", () => {
    const result = confluentProduceSchema.safeParse({
      topic: "my-topic",
      key: "record-key",
      value: { event: "test" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty topic", () => {
    const result = confluentProduceSchema.safeParse({
      topic: "",
      value: { event: "test" },
    });
    expect(result.success).toBe(false);
  });
});

describe("confluentCreateTopicSchema", () => {
  it("accepts valid topic creation", () => {
    const result = confluentCreateTopicSchema.safeParse({
      name: "new-topic",
      partitions: 6,
      replicationFactor: 3,
    });
    expect(result.success).toBe(true);
  });

  it("applies defaults for partitions and replicationFactor", () => {
    const result = confluentCreateTopicSchema.safeParse({ name: "topic" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.partitions).toBe(1);
      expect(result.data.replicationFactor).toBe(3);
    }
  });

  it("rejects partitions > 100", () => {
    const result = confluentCreateTopicSchema.safeParse({
      name: "topic",
      partitions: 101,
    });
    expect(result.success).toBe(false);
  });
});
