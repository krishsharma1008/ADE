import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createJiraClient } from "../services/jira.js";
import type { JiraConfig } from "@combyne/shared";

const mockConfig: JiraConfig = {
  baseUrl: "https://test.atlassian.net",
  email: "user@example.com",
  apiToken: "test-token-123",
  projectKey: "TEST",
};

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe("createJiraClient", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("testConnection", () => {
    it("returns ok true when Jira responds successfully", async () => {
      global.fetch = mockFetch(200, { serverTitle: "My Jira" });
      const client = createJiraClient(mockConfig);
      const result = await client.testConnection();
      expect(result).toEqual({ ok: true, serverTitle: "My Jira" });
    });

    it("returns ok false when Jira responds with an error", async () => {
      global.fetch = mockFetch(401, { message: "Unauthorized" });
      const client = createJiraClient(mockConfig);
      const result = await client.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("listProjects", () => {
    it("maps Jira project response to JiraProject[]", async () => {
      global.fetch = mockFetch(200, {
        values: [
          { id: "10001", key: "PROJ", name: "Project One" },
          { id: "10002", key: "TEST", name: "Test Project" },
        ],
      });
      const client = createJiraClient(mockConfig);
      const projects = await client.listProjects();
      expect(projects).toHaveLength(2);
      expect(projects[0]).toEqual({ id: "10001", key: "PROJ", name: "Project One" });
    });
  });

  describe("searchIssues", () => {
    it("uses default JQL when none provided", async () => {
      const fetchMock = mockFetch(200, { issues: [] });
      global.fetch = fetchMock;
      const client = createJiraClient(mockConfig);
      await client.searchIssues();
      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain("project%20%3D%20TEST");
    });

    it("maps issue fields correctly", async () => {
      global.fetch = mockFetch(200, {
        issues: [
          {
            id: "10001",
            key: "TEST-1",
            fields: {
              summary: "Fix bug",
              description: "Description text",
              status: { name: "To Do" },
              priority: { name: "High" },
              assignee: { displayName: "John Doe" },
              created: "2025-01-01T00:00:00.000Z",
              updated: "2025-01-02T00:00:00.000Z",
            },
          },
        ],
      });
      const client = createJiraClient(mockConfig);
      const issues = await client.searchIssues("project = TEST");
      expect(issues).toHaveLength(1);
      expect(issues[0]).toEqual({
        id: "10001",
        key: "TEST-1",
        summary: "Fix bug",
        description: "Description text",
        status: "To Do",
        priority: "High",
        assignee: "John Doe",
        created: "2025-01-01T00:00:00.000Z",
        updated: "2025-01-02T00:00:00.000Z",
      });
    });

    it("handles null assignee and priority", async () => {
      global.fetch = mockFetch(200, {
        issues: [
          {
            id: "10002",
            key: "TEST-2",
            fields: {
              summary: "No assignee",
              description: null,
              status: { name: "Done" },
              priority: null,
              assignee: null,
              created: "2025-01-01T00:00:00.000Z",
              updated: "2025-01-01T00:00:00.000Z",
            },
          },
        ],
      });
      const client = createJiraClient(mockConfig);
      const issues = await client.searchIssues();
      expect(issues[0].priority).toBeNull();
      expect(issues[0].assignee).toBeNull();
    });
  });

  describe("getIssue", () => {
    it("fetches a single issue by key", async () => {
      const fetchMock = mockFetch(200, {
        id: "10001",
        key: "TEST-1",
        fields: {
          summary: "Single issue",
          description: null,
          status: { name: "In Progress" },
          priority: { name: "Medium" },
          assignee: null,
          created: "2025-01-01T00:00:00.000Z",
          updated: "2025-01-01T00:00:00.000Z",
        },
      });
      global.fetch = fetchMock;
      const client = createJiraClient(mockConfig);
      const issue = await client.getIssue("TEST-1");
      expect(issue.key).toBe("TEST-1");
      expect(issue.summary).toBe("Single issue");
      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/issue/TEST-1");
    });
  });

  describe("createIssue", () => {
    it("sends correct payload to Jira", async () => {
      const fetchMock = mockFetch(201, { id: "10003", key: "TEST-3", self: "https://test.atlassian.net/rest/api/3/issue/10003" });
      global.fetch = fetchMock;
      const client = createJiraClient(mockConfig);
      const result = await client.createIssue("New task", "Task description");
      expect(result.key).toBe("TEST-3");
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.fields.project.key).toBe("TEST");
      expect(body.fields.summary).toBe("New task");
      expect(body.fields.issuetype.name).toBe("Task");
    });
  });

  describe("transitionIssue", () => {
    it("finds and applies the correct transition", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              transitions: [
                { id: "21", name: "Done", to: { name: "Done" } },
                { id: "31", name: "In Progress", to: { name: "In Progress" } },
              ],
            }),
          text: () => Promise.resolve(""),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 204,
          json: () => Promise.resolve(undefined),
          text: () => Promise.resolve(""),
        });
      global.fetch = fetchMock;
      const client = createJiraClient(mockConfig);
      await client.transitionIssue("TEST-1", "Done");
      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.transition.id).toBe("21");
    });

    it("throws when transition is not available", async () => {
      global.fetch = mockFetch(200, {
        transitions: [{ id: "21", name: "Done", to: { name: "Done" } }],
      });
      const client = createJiraClient(mockConfig);
      await expect(client.transitionIssue("TEST-1", "Nonexistent")).rejects.toThrow(
        /No transition to "Nonexistent" available/,
      );
    });
  });

  describe("addComment", () => {
    it("sends ADF-formatted comment body", async () => {
      const fetchMock = mockFetch(201, { id: "10001" });
      global.fetch = fetchMock;
      const client = createJiraClient(mockConfig);
      await client.addComment("TEST-1", "Hello from Combyne");
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.body.type).toBe("doc");
      expect(body.body.content[0].content[0].text).toBe("Hello from Combyne");
    });
  });

  describe("authentication", () => {
    it("sends correct Basic auth header", async () => {
      const fetchMock = mockFetch(200, { values: [] });
      global.fetch = fetchMock;
      const client = createJiraClient(mockConfig);
      await client.listProjects();
      const headers = fetchMock.mock.calls[0][1].headers;
      const expected = "Basic " + Buffer.from("user@example.com:test-token-123").toString("base64");
      expect(headers.Authorization).toBe(expected);
    });
  });
});
