import { Router } from "express";
import type { Db } from "@combyne/db";
import {
  createIntegrationSchema,
  updateIntegrationSchema,
  jiraSyncIssuesSchema,
  confluentProduceSchema,
  confluentCreateTopicSchema,
  githubCreatePRSchema,
  githubCreateBranchSchema,
  githubMergePRSchema,
  githubCreateReviewSchema,
  githubCreateCommentSchema,
  sonarqubeListIssuesSchema,
  sonarqubeGetMetricsSchema,
  type JiraConfig,
  type ConfluentConfig,
  type GitHubConfig,
  type SonarQubeConfig,
  type IntegrationProvider,
} from "@combyne/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity } from "../services/index.js";
import { integrationService } from "../services/integrations.js";
import { createJiraClient } from "../services/jira.js";
import { createConfluentClient } from "../services/confluent.js";
import { createGitHubClient } from "../services/github.js";
import { createSonarQubeClient } from "../services/sonarqube.js";
import { badRequest, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";

export function integrationRoutes(db: Db) {
  const router = Router();
  const svc = integrationService(db);

  // ── CRUD ──────────────────────────────────────────────────────────

  /** List integrations for a company. */
  router.get("/companies/:companyId/integrations", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const integrations = await svc.list(companyId);
    res.json(integrations.map(redactSecrets));
  });

  /** Get a single integration. */
  router.get("/companies/:companyId/integrations/:provider", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    const provider = req.params.provider as string;
    assertCompanyAccess(req, companyId);
    const row = await svc.getByProvider(companyId, provider as IntegrationProvider);
    if (!row) {
      res.status(404).json({ error: "Integration not found" });
      return;
    }
    res.json(redactSecrets(row));
  });

  /** Create / connect an integration. */
  router.post(
    "/companies/:companyId/integrations",
    validate(createIntegrationSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const existing = await svc.getByProvider(companyId, req.body.provider);
      if (existing) {
        throw badRequest(`${req.body.provider} integration already exists for this company`);
      }

      const row = await svc.create(
        companyId,
        req.body.provider,
        req.body.config as Record<string, unknown>,
        req.actor.userId ?? "board",
      );

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "integration.created",
        entityType: "integration",
        entityId: row.id,
        details: { provider: req.body.provider },
      });

      logger.info({ provider: req.body.provider, companyId }, "Integration created");
      res.status(201).json(redactSecrets(row));
    },
  );

  /** Update an integration config or enabled state. */
  router.patch(
    "/companies/:companyId/integrations/:provider",
    validate(updateIntegrationSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const provider = req.params.provider as string;
      assertCompanyAccess(req, companyId);

      const existing = await svc.getByProvider(companyId, provider as IntegrationProvider);
      if (!existing) throw notFound("Integration not found");

      const patch: { enabled?: string; config?: Record<string, unknown> } = {};
      if (req.body.enabled !== undefined) {
        patch.enabled = String(req.body.enabled);
      }
      if (req.body.config) {
        patch.config = req.body.config as Record<string, unknown>;
      }
      const row = await svc.update(existing.id, patch);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "integration.updated",
        entityType: "integration",
        entityId: existing.id,
        details: { provider },
      });

      res.json(redactSecrets(row));
    },
  );

  /** Delete / disconnect an integration. */
  router.delete("/companies/:companyId/integrations/:provider", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    const provider = req.params.provider as string;
    assertCompanyAccess(req, companyId);

    const existing = await svc.getByProvider(companyId, provider as IntegrationProvider);
    if (!existing) throw notFound("Integration not found");

    await svc.delete(existing.id);

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "integration.deleted",
      entityType: "integration",
      entityId: existing.id,
      details: { provider },
    });

    logger.info({ provider, companyId }, "Integration deleted");
    res.status(204).end();
  });

  // ── Test connection ───────────────────────────────────────────────

  router.post("/companies/:companyId/integrations/:provider/test", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    const provider = req.params.provider as string;
    assertCompanyAccess(req, companyId);

    const existing = await svc.getByProvider(companyId, provider as IntegrationProvider);
    if (!existing) throw notFound("Integration not found");

    if (provider === "jira") {
      const client = createJiraClient(existing.config as unknown as JiraConfig);
      const result = await client.testConnection();
      res.json(result);
    } else if (provider === "confluent") {
      const client = createConfluentClient(existing.config as unknown as ConfluentConfig);
      const result = await client.testConnection();
      res.json(result);
    } else if (provider === "github") {
      const client = createGitHubClient(existing.config as unknown as GitHubConfig);
      const result = await client.testConnection();
      res.json(result);
    } else if (provider === "sonarqube") {
      const client = createSonarQubeClient(existing.config as unknown as SonarQubeConfig);
      const result = await client.testConnection();
      res.json(result);
    } else {
      throw badRequest("Unknown provider");
    }
  });

  // ── Jira operations ───────────────────────────────────────────────

  router.get("/companies/:companyId/integrations/jira/projects", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const config = await requireJiraConfig(companyId);
    const client = createJiraClient(config);
    const projects = await client.listProjects();
    res.json(projects);
  });

  router.get("/companies/:companyId/integrations/jira/issues", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const config = await requireJiraConfig(companyId);
    const client = createJiraClient(config);
    const parsed = jiraSyncIssuesSchema.parse({
      jql: req.query.jql,
      maxResults: req.query.maxResults ? Number(req.query.maxResults) : undefined,
    });
    const issues = await client.searchIssues(parsed.jql, parsed.maxResults);
    res.json(issues);
  });

  router.get("/companies/:companyId/integrations/jira/issues/:issueKey", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    const issueKey = req.params.issueKey as string;
    assertCompanyAccess(req, companyId);
    const config = await requireJiraConfig(companyId);
    const client = createJiraClient(config);
    const issue = await client.getIssue(issueKey);
    res.json(issue);
  });

  router.post("/companies/:companyId/integrations/jira/issues", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const config = await requireJiraConfig(companyId);
    const client = createJiraClient(config);
    const { summary, description, issueType } = req.body;
    if (!summary) throw badRequest("summary is required");
    const created = await client.createIssue(summary, description, issueType);

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "jira.issue.created",
      entityType: "integration",
      entityId: created.key,
      details: { key: created.key },
    });

    res.status(201).json(created);
  });

  router.post(
    "/companies/:companyId/integrations/jira/issues/:issueKey/transition",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const issueKey = req.params.issueKey as string;
      assertCompanyAccess(req, companyId);
      const config = await requireJiraConfig(companyId);
      const client = createJiraClient(config);
      const { status } = req.body;
      if (!status) throw badRequest("status is required");
      await client.transitionIssue(issueKey, status);
      res.json({ ok: true });
    },
  );

  router.post(
    "/companies/:companyId/integrations/jira/issues/:issueKey/comment",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const issueKey = req.params.issueKey as string;
      assertCompanyAccess(req, companyId);
      const config = await requireJiraConfig(companyId);
      const client = createJiraClient(config);
      const { body } = req.body;
      if (!body) throw badRequest("body is required");
      const comment = await client.addComment(issueKey, body);
      res.status(201).json(comment);
    },
  );

  // ── Confluent operations ──────────────────────────────────────────

  router.get("/companies/:companyId/integrations/confluent/topics", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const config = await requireConfluentConfig(companyId);
    const client = createConfluentClient(config);
    const topics = await client.listTopics();
    res.json(topics);
  });

  router.post(
    "/companies/:companyId/integrations/confluent/topics",
    validate(confluentCreateTopicSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const config = await requireConfluentConfig(companyId);
      const client = createConfluentClient(config);
      const topic = await client.createTopic(
        req.body.name,
        req.body.partitions,
        req.body.replicationFactor,
      );

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "confluent.topic.created",
        entityType: "integration",
        entityId: req.body.name,
        details: { topic: req.body.name },
      });

      res.status(201).json(topic);
    },
  );

  router.delete(
    "/companies/:companyId/integrations/confluent/topics/:topicName",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const topicName = req.params.topicName as string;
      assertCompanyAccess(req, companyId);
      const config = await requireConfluentConfig(companyId);
      const client = createConfluentClient(config);
      await client.deleteTopic(topicName);
      res.status(204).end();
    },
  );

  router.post(
    "/companies/:companyId/integrations/confluent/produce",
    validate(confluentProduceSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const config = await requireConfluentConfig(companyId);
      const client = createConfluentClient(config);
      const result = await client.produce(req.body.topic, req.body.value, req.body.key);
      res.status(201).json(result);
    },
  );

  // ── GitHub operations ─────────────────────────────────────────────

  router.get("/companies/:companyId/integrations/github/repos", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const config = await requireGitHubConfig(companyId);
    const client = createGitHubClient(config);
    const repos = await client.listRepos();
    res.json(repos);
  });

  router.get("/companies/:companyId/integrations/github/repos/:repo", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    const repo = req.params.repo as string;
    assertCompanyAccess(req, companyId);
    const config = await requireGitHubConfig(companyId);
    const client = createGitHubClient(config);
    const result = await client.getRepo(repo);
    res.json(result);
  });

  router.get(
    "/companies/:companyId/integrations/github/repos/:repo/branches",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const repo = req.params.repo as string;
      assertCompanyAccess(req, companyId);
      const config = await requireGitHubConfig(companyId);
      const client = createGitHubClient(config);
      const branches = await client.listBranches(repo);
      res.json(branches);
    },
  );

  router.post(
    "/companies/:companyId/integrations/github/repos/:repo/branches",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const repo = req.params.repo as string;
      assertCompanyAccess(req, companyId);
      const parsed = githubCreateBranchSchema.parse({ ...req.body, repo });
      const config = await requireGitHubConfig(companyId);
      const client = createGitHubClient(config);
      const branch = await client.createBranch(repo, parsed.branch, parsed.fromBranch);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "github.branch.created",
        entityType: "integration",
        entityId: `${repo}/${parsed.branch}`,
        details: { repo, branch: parsed.branch },
      });

      res.status(201).json(branch);
    },
  );

  router.get(
    "/companies/:companyId/integrations/github/repos/:repo/pulls",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const repo = req.params.repo as string;
      assertCompanyAccess(req, companyId);
      const config = await requireGitHubConfig(companyId);
      const client = createGitHubClient(config);
      const state = (req.query.state as "open" | "closed" | "all") || undefined;
      const pulls = await client.listPullRequests(repo, state);
      res.json(pulls);
    },
  );

  router.get(
    "/companies/:companyId/integrations/github/repos/:repo/pulls/:pullNumber",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const repo = req.params.repo as string;
      const pullNumber = Number(req.params.pullNumber);
      assertCompanyAccess(req, companyId);
      const config = await requireGitHubConfig(companyId);
      const client = createGitHubClient(config);
      const pr = await client.getPullRequest(repo, pullNumber);
      res.json(pr);
    },
  );

  router.post(
    "/companies/:companyId/integrations/github/repos/:repo/pulls",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const repo = req.params.repo as string;
      assertCompanyAccess(req, companyId);
      const parsed = githubCreatePRSchema.parse({ ...req.body, repo });
      const config = await requireGitHubConfig(companyId);
      const client = createGitHubClient(config);
      const pr = await client.createPullRequest(repo, parsed.title, parsed.head, parsed.base, parsed.body);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "github.pr.created",
        entityType: "integration",
        entityId: `${repo}#${pr.number}`,
        details: { repo, pr: pr.number },
      });

      res.status(201).json(pr);
    },
  );

  router.put(
    "/companies/:companyId/integrations/github/repos/:repo/pulls/:pullNumber/merge",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const repo = req.params.repo as string;
      const pullNumber = Number(req.params.pullNumber);
      assertCompanyAccess(req, companyId);
      const parsed = githubMergePRSchema.parse({ ...req.body, repo, pullNumber });
      const config = await requireGitHubConfig(companyId);
      const client = createGitHubClient(config);
      const result = await client.mergePullRequest(repo, pullNumber, parsed.mergeMethod);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "github.pr.merged",
        entityType: "integration",
        entityId: `${repo}#${pullNumber}`,
        details: { repo, pr: pullNumber },
      });

      res.json(result);
    },
  );

  router.get(
    "/companies/:companyId/integrations/github/repos/:repo/pulls/:pullNumber/reviews",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const repo = req.params.repo as string;
      const pullNumber = Number(req.params.pullNumber);
      assertCompanyAccess(req, companyId);
      const config = await requireGitHubConfig(companyId);
      const client = createGitHubClient(config);
      const reviews = await client.listPRReviews(repo, pullNumber);
      res.json(reviews);
    },
  );

  router.post(
    "/companies/:companyId/integrations/github/repos/:repo/pulls/:pullNumber/reviews",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const repo = req.params.repo as string;
      const pullNumber = Number(req.params.pullNumber);
      assertCompanyAccess(req, companyId);
      const parsed = githubCreateReviewSchema.parse({ ...req.body, repo, pullNumber });
      const config = await requireGitHubConfig(companyId);
      const client = createGitHubClient(config);
      const review = await client.createPRReview(repo, pullNumber, parsed.body, parsed.event);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "github.pr.review.created",
        entityType: "integration",
        entityId: `${repo}#${pullNumber}`,
        details: { repo, pr: pullNumber, event: parsed.event },
      });

      res.status(201).json(review);
    },
  );

  router.post(
    "/companies/:companyId/integrations/github/repos/:repo/pulls/:pullNumber/comments",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const repo = req.params.repo as string;
      const pullNumber = Number(req.params.pullNumber);
      assertCompanyAccess(req, companyId);
      const parsed = githubCreateCommentSchema.parse({ ...req.body, repo, pullNumber });
      const config = await requireGitHubConfig(companyId);
      const client = createGitHubClient(config);
      const comment = await client.createPRComment(repo, pullNumber, parsed.body);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "github.pr.comment.created",
        entityType: "integration",
        entityId: `${repo}#${pullNumber}`,
        details: { repo, pr: pullNumber },
      });

      res.status(201).json(comment);
    },
  );

  router.get(
    "/companies/:companyId/integrations/github/repos/:repo/commits/:ref/checks",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const repo = req.params.repo as string;
      const ref = req.params.ref as string;
      assertCompanyAccess(req, companyId);
      const config = await requireGitHubConfig(companyId);
      const client = createGitHubClient(config);
      const checks = await client.listCheckRuns(repo, ref);
      res.json(checks);
    },
  );

  router.get(
    "/companies/:companyId/integrations/github/repos/:repo/clone-url",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const repo = req.params.repo as string;
      assertCompanyAccess(req, companyId);
      const config = await requireGitHubConfig(companyId);
      const client = createGitHubClient(config);
      const cloneUrl = await client.getCloneUrl(repo);
      res.json(cloneUrl);
    },
  );

  // ── SonarQube operations ──────────────────────────────────────────

  router.get(
    "/companies/:companyId/integrations/sonarqube/quality-gate",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const config = await requireSonarQubeConfig(companyId);
      const client = createSonarQubeClient(config);
      const projectKey = (req.query.projectKey as string) || undefined;
      const result = await client.getQualityGateStatus(projectKey);
      res.json(result);
    },
  );

  router.get("/companies/:companyId/integrations/sonarqube/issues", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const config = await requireSonarQubeConfig(companyId);
    const client = createSonarQubeClient(config);
    const parsed = sonarqubeListIssuesSchema.parse({
      projectKey: req.query.projectKey,
      types: req.query.types,
      severities: req.query.severities,
      statuses: req.query.statuses,
      maxResults: req.query.maxResults ? Number(req.query.maxResults) : undefined,
    });
    const issues = await client.listIssues({
      projectKey: parsed.projectKey,
      types: parsed.types ? parsed.types.split(",") : undefined,
      severities: parsed.severities ? parsed.severities.split(",") : undefined,
      pageSize: parsed.maxResults,
    });
    res.json(issues);
  });

  router.get("/companies/:companyId/integrations/sonarqube/metrics", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const config = await requireSonarQubeConfig(companyId);
    const client = createSonarQubeClient(config);
    const parsed = sonarqubeGetMetricsSchema.parse({
      projectKey: req.query.projectKey,
      metricKeys: req.query.metricKeys,
    });
    const metrics = await client.getMetrics(parsed.projectKey, parsed.metricKeys.split(","));
    res.json(metrics);
  });

  router.get(
    "/companies/:companyId/integrations/sonarqube/analysis-status",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const config = await requireSonarQubeConfig(companyId);
      const client = createSonarQubeClient(config);
      const projectKey = (req.query.projectKey as string) || undefined;
      const result = await client.getAnalysisStatus(projectKey);
      res.json(result);
    },
  );

  // ── Helpers ───────────────────────────────────────────────────────

  async function requireJiraConfig(companyId: string): Promise<JiraConfig> {
    const row = await svc.getByProvider(companyId, "jira");
    if (!row || row.enabled !== "true") {
      throw notFound("Jira integration is not configured or is disabled");
    }
    return row.config as unknown as JiraConfig;
  }

  async function requireConfluentConfig(companyId: string): Promise<ConfluentConfig> {
    const row = await svc.getByProvider(companyId, "confluent");
    if (!row || row.enabled !== "true") {
      throw notFound("Confluent integration is not configured or is disabled");
    }
    return row.config as unknown as ConfluentConfig;
  }

  async function requireGitHubConfig(companyId: string): Promise<GitHubConfig> {
    const row = await svc.getByProvider(companyId, "github");
    if (!row || row.enabled !== "true") {
      throw notFound("GitHub integration is not configured or is disabled");
    }
    return row.config as unknown as GitHubConfig;
  }

  async function requireSonarQubeConfig(companyId: string): Promise<SonarQubeConfig> {
    const row = await svc.getByProvider(companyId, "sonarqube");
    if (!row || row.enabled !== "true") {
      throw notFound("SonarQube integration is not configured or is disabled");
    }
    return row.config as unknown as SonarQubeConfig;
  }

  return router;
}

/** Redact sensitive fields (tokens, secrets) from integration config before returning to client. */
function redactSecrets(row: Record<string, unknown>) {
  const config = row.config as Record<string, unknown> | null;
  if (!config) return row;
  const redacted = { ...config };
  for (const key of ["apiToken", "apiSecret", "token"]) {
    if (typeof redacted[key] === "string") {
      const val = redacted[key] as string;
      redacted[key] = val.length > 4 ? `${"*".repeat(val.length - 4)}${val.slice(-4)}` : "****";
    }
  }
  return { ...row, config: redacted };
}
