---
name: buku-rfc-generation
description: >
  Generate technical RFCs from PRDs using BukuWarung's 34-service architecture.
  Use when given a PRD, product spec, or feature request that needs a technical
  design document. Covers service identification, dependency mapping, solution
  design, and RFC document generation following BUKU's template and guidelines.
  Do NOT use for coding tasks (use buku-code-development skill).
---

# RFC Generation Skill

## Workflow

```
PRD → Analyze → Identify Services → Design → Generate RFC
```

### Step 1: Analyze the PRD

Extract these elements:
- **Problem**: What user/business problem is being solved?
- **Requirements**: Functional and non-functional requirements
- **Users**: Who uses this feature?
- **Success Metrics**: How will success be measured?
- **Constraints**: Timeline, compliance, technical limitations

### Step 2: Identify Affected Services

Use `references/architecture.md` (via `buku` skill) to map requirements to services:

| Requirement Type | Services |
|------------------|----------|
| Authentication, login, OTP | multi-tenant-auth, notification |
| Payments, disbursement, VA | payments, banking, accounting-service |
| KYC, identity verification | janus, kyc-liveliness, user-trust |
| Loans, credit, BNPL | los-lender, fs-bnpl-service, lms-client, risk |
| Digital products (pulsa, bills) | finpro, digital-product-adapter |
| E-commerce, orders | tokoko-service |
| Loyalty, rewards | loyalty |
| Risk assessment | risk, user-trust |
| Business rules, routing | rule-engine |
| EDC, terminal operations | edc-adapter, miniatm-backend |
| QRIS, retail | retail-backend |
| Analytics, reporting | dracula-v2, data-analytics, transaction-history |
| Admin tools | golden-gate, panacea |

For each service, check:
- `references/services/{service-name}.md` (via `buku` skill) for details
- `references/gateway-routes.md` (via `buku` skill) for API routes

### Step 3: Map Dependencies

For each affected service, identify:
1. **Upstream**: Services it calls
2. **Downstream**: Services that call it
3. **Kafka topics**: Events published/consumed
4. **Database**: Tables accessed

Key integration points:
```
Kafka Topics:
  transactions     → dracula-v2, transaction-history, loyalty
  payments         → dracula-v2, risk, notification
  user-events      → dracula-v2, loyalty, risk
  banking-events   → dracula-v2, transaction-history
  lending-events   → dracula-v2, risk

Sync Dependencies:
  All services     → multi-tenant-auth (token validation)
  payments         → rule-engine (routing)
  lending          → janus (KYC), risk (credit)
```

### Step 4: Design the Solution

For the RFC, determine:

**API Changes**
- New endpoints needed
- Modified endpoints
- Request/response schemas
- Versioning (v1, v2, v3)

**Database Changes**
- New tables/columns
- Migrations (Flyway)
- Indexes

**Kafka Events**
- New events to publish
- Events to consume
- Schema design

**Integrations**
- Sync calls (Feign)
- Async calls (Kafka)
- External providers

### Step 5: Generate RFC

Use `references/rfc-template.md` as the structure.
Follow `references/rfc-guidelines.md` for section-by-section guidance.

---

## RFC Output Structure

```markdown
# RFC: [Title from PRD]

## Status
- [x] Draft

## Context
[Summarize PRD problem - 2-3 paragraphs]

## Proposal
[High-level solution - 1 paragraph]

## Goals
- [Measurable goals from PRD]
- Non-goals: [What's out of scope]

## Design

### Architecture Overview
[ASCII diagram of services involved]

### Key Components
[Per-service breakdown]

### Data Flow
[Numbered sequence]

### Health Monitoring & Failover Logic
[Circuit breakers, retries, health checks]

### Override Mechanism
[If applicable - manual routing/config overrides]

### Auditing & Logging
[What's logged, retention, BWLogger fields]

## Implementation Plan
[Phased rollout with checkboxes]

## Rollback Plan
[Immediate, code, data rollback steps]

## Testing Strategy
[Unit, integration, e2e, performance]

## Open Questions
[Unresolved decisions needing team input]

## Prior Art / Alternatives Considered
[What was evaluated and why rejected]

## Security & Compliance
[Auth, authz, PII, encryption, audit]

## Performance Impact
[Latency, throughput, resource estimates]

## Monitoring & Observability
[Datadog metrics, alerts, dashboards, logs]

## Appendix
[Schemas, diagrams, config examples]
```

---

## Patterns to Apply

When designing, ensure compliance with `references/patterns.md` (via `buku-code-development` skill):

| Concern | Pattern |
|---------|---------|
| Authentication | JWT via app-gateway, validate with multi-tenant-auth |
| Error Handling | Zalando Problem, standard error codes (AUTH_401, etc.) |
| Kafka Events | Spring Cloud Stream, `{domain}.{entity}.{past_tense_verb}` |
| Database | JPA with audit fields, Flyway migrations |
| Resilience | Resilience4j circuit breaker, exponential backoff retry |
| Caching | Redisson, 5-min TTL typical |
| Logging | BWLogger structured logging, mask sensitive fields |

---

## Tech Stack Reference

| Java Version | Services |
|--------------|----------|
| Java 21 | multi-tenant-auth, dracula-v2, miniatm-backend, retail-backend |
| Java 17 | transaction-history, edc-adapter, rafana |
| Java 11 | los-lender, risk, banking, janus, golden-gate, fs-bnpl-service |
| Java 8 | accounting-service, payments, finpro, loyalty, data-analytics |

| Framework | Services |
|-----------|----------|
| Reactive (WebFlux) | banking, miniatm-backend, retail-backend, transaction-history, lms-client |
| Traditional (MVC) | Most others |
| Hexagonal | los-lender, finpro, janus, edc-adapter, miniatm-backend, retail-backend |

---

## Service-Specific Notes

**multi-tenant-auth**: Changes affect ALL services. Coordinate rollout.

**payments**: Idempotency critical. Consider reconciliation impact.

**banking**: External bank APIs. Plan for timeouts and retries.

**Kafka events**: Backward compatibility required. Plan for consumer lag.

**Database**: Zero-downtime migrations. Plan backfills for new non-nullable columns.

---

## Checklist Before Submitting RFC

- [ ] All affected services identified
- [ ] Architecture diagram included
- [ ] Data flow covers happy + error paths
- [ ] API schemas documented
- [ ] Database migrations specified
- [ ] Kafka events with schemas
- [ ] Rollback plan is actionable
- [ ] Performance impact estimated
- [ ] Monitoring/alerts defined
- [ ] Open questions clearly stated
