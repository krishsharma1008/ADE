# RFC Generation Guidelines

Instructions for generating RFCs from PRDs using BukuWarung's architecture.

---

## RFC Generation Workflow

When given a PRD, follow these steps:

### Step 1: Analyze the PRD

Extract from the PRD:
- **Problem Statement**: What user/business problem is being solved?
- **Requirements**: Functional and non-functional requirements
- **User Stories**: Who does what and why?
- **Success Metrics**: How will success be measured?
- **Constraints**: Timeline, budget, regulatory requirements

### Step 2: Identify Affected Services

Use `ARCHITECTURE.md` to map requirements to services:

| Requirement Type | Likely Services |
|------------------|-----------------|
| User authentication/login | multi-tenant-auth |
| Send SMS/WhatsApp/Push | notification |
| KYC/identity verification | janus, kyc-liveliness |
| Payment processing | payments, banking |
| Loan/credit features | los-lender, fs-bnpl-service, lms-client |
| Digital products (pulsa, bills) | finpro, digital-product-adapter |
| E-commerce/orders | tokoko-service |
| Loyalty/rewards | loyalty |
| Risk assessment | risk, user-trust |
| Business rules/routing | rule-engine |
| Transaction records | accounting-service, transaction-history |
| EDC/terminal operations | edc-adapter, miniatm-backend |
| QRIS/retail payments | retail-backend |
| Data analytics | dracula-v2, data-analytics |
| Admin operations | golden-gate, panacea |

### Step 3: Map Service Dependencies

For each affected service, identify:

1. **Upstream dependencies** (services it calls)
2. **Downstream consumers** (services that call it)
3. **Kafka topics** (events published/consumed)
4. **Shared databases** (if any)

Reference `ARCHITECTURE.md` → Service Communication Patterns section.

### Step 4: Design the Solution

For each component, determine:

#### API Changes
- New endpoints needed
- Existing endpoints to modify
- Request/response schemas
- API versioning (v1, v2, v3)

Use `app-gateway-downstream-services.md` for route patterns.

#### Database Changes
- New tables/columns
- Migrations needed
- Index requirements
- Data retention policies

Use naming conventions from `code-conventions.md`.

#### Kafka Events
- New events to publish
- Events to consume
- Event schema design

Follow event naming: `{domain}.{entity}.{past_tense_verb}`

Reference `patterns.md` → Kafka Event Pattern section.

#### Service Integrations
- Synchronous calls (Feign clients)
- Asynchronous calls (Kafka)
- External provider integrations

### Step 5: Apply BukuWarung Patterns

Ensure the design follows established patterns:

| Concern | Pattern Reference |
|---------|-------------------|
| Authentication | `patterns.md` → Authentication Pattern |
| Error handling | `patterns.md` → Error Handling Pattern |
| Event publishing | `patterns.md` → Kafka Event Pattern |
| Database access | `patterns.md` → Database Pattern |
| External calls | `patterns.md` → Resilience Pattern |
| Caching | `patterns.md` → Caching Pattern |

### Step 6: Generate the RFC

Use `rfc-template.md` and fill in each section.

---

## Section-by-Section Guidance

### Status
Always start as Draft:
```
- [x] Draft
- [ ] Proposed
- [ ] Accepted
- [ ] Rejected
- [ ] Superseded
```

### Context
- Summarize the PRD problem statement
- Explain current pain points and limitations
- Quantify the impact (users affected, revenue impact, manual effort, etc.)
- Keep it brief - 2-3 paragraphs max

### Proposal
- One paragraph high-level summary of the solution
- Avoid technical depth here - save details for Design section
- Focus on the "what" not the "how"

### Goals
List specific, measurable goals and explicit non-goals:
```
Goals:
- Enable [feature] for [user segment]
- Reduce [metric] by [X]%
- Support [X] transactions per second

Non-goals (what this RFC does NOT address):
- Migration of existing [data/feature] is out of scope
- [Related feature] will be addressed in a separate RFC
- Performance optimization beyond [X] TPS
```

### Design - Architecture Overview

Create a diagram showing:
- Services involved
- Data flow direction
- Sync vs async communication

Use ASCII or Mermaid diagrams:
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Client    │────▶│ app-gateway │────▶│  Service A  │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
                         ┌─────────────────────┼─────────────────────┐
                         │                     │                     │
                         ▼                     ▼                     ▼
                  ┌─────────────┐       ┌─────────────┐       ┌─────────────┐
                  │  Service B  │       │    Kafka    │       │  Service C  │
                  └─────────────┘       └─────────────┘       └─────────────┘
```

### Design - Key Components

For each affected service, describe:
```
### [Service Name]

**Responsibility**: What this service does in this feature

**New Components**:
- `NewService.java` - Description
- `NewController.java` - Description

**Modified Components**:
- `ExistingService.java` - What changes and why

**New Dependencies**:
- Calls to [other service] via Feign for [purpose]
- Publishes to [Kafka topic] for [purpose]
```

### Design - Data Flow

Numbered sequence showing the complete flow:
```
1. User initiates [action] via mobile app
2. Request hits app-gateway, authenticated via Firebase
3. Gateway routes to [service] at `/api/v1/[endpoint]`
4. [Service] validates request using [validation logic]
5. [Service] calls [dependency] for [data/operation]
6. [Service] persists [entity] to PostgreSQL
7. [Service] publishes event to Kafka topic `[topic-name]`
8. [Consumer service] processes event and [action]
9. notification service sends [SMS/push] to user
10. User receives [response/notification]
```

### Design - Health Monitoring & Failover Logic

Document resilience mechanisms:
```
### Health Checks
- Endpoint: `/actuator/health`
- Checks: Database connectivity, Kafka connectivity, downstream services
- Interval: 10 seconds
- Unhealthy threshold: 3 consecutive failures

### Circuit Breaker (Resilience4j)
- Failure rate threshold: 50%
- Sliding window size: 10 requests
- Wait duration in open state: 10 seconds
- Permitted calls in half-open: 3

### Retry Policy
- Max attempts: 3
- Initial interval: 1 second
- Multiplier: 2 (exponential backoff)
- Retryable exceptions: TimeoutException, ConnectionException

### Fallback Behavior
- [Service A] unavailable → Return cached response / queue for retry
- [External provider] unavailable → Failover to [backup provider]
```

### Design - Override Mechanism

If the feature involves routing or provider selection:
```
### Manual Override Configuration
- Storage: AWS Parameter Store / database table
- Format: JSON configuration
- Scope: Per-tenant / global

### Override Schema
```json
{
  "overrideId": "string",
  "targetEntity": "merchant|user|global",
  "entityId": "string (optional)",
  "routingRule": {
    "provider": "PROVIDER_A",
    "priority": 1
  },
  "validFrom": "ISO8601",
  "validUntil": "ISO8601",
  "createdBy": "admin-user-id"
}
```

### Override Precedence
1. Entity-specific override (highest priority)
2. Tenant-level override
3. Global override
4. Default routing rules (lowest priority)
```

### Design - Auditing & Logging

```
### Audit Events
| Event | Trigger | Data Captured |
|-------|---------|---------------|
| [Feature]_INITIATED | User starts action | userId, requestId, timestamp, input params |
| [Feature]_COMPLETED | Action succeeds | userId, requestId, timestamp, result, duration |
| [Feature]_FAILED | Action fails | userId, requestId, timestamp, errorCode, errorMessage |

### Logging Strategy
- Logger: BWLogger (structured JSON)
- Log level: INFO for business events, ERROR for failures
- Sensitive data: Masked (pin, password, full card number)

### Log Retention
- Application logs: 30 days (CloudWatch)
- Audit logs: 1 year (S3)
- Transaction logs: 7 years (compliance requirement)
```

### Implementation Plan

Structure as phases with clear deliverables:
```
### Phase 1: Foundation (Week 1-2)
- [ ] Database migrations for [tables]
- [ ] Core domain models and entities
- [ ] Repository layer with unit tests
- [ ] Service layer skeleton

### Phase 2: Core Implementation (Week 2-3)
- [ ] API endpoints in [service]
- [ ] Feign client to [dependency]
- [ ] Business logic implementation
- [ ] Integration tests

### Phase 3: Event Integration (Week 3-4)
- [ ] Kafka producer for [events]
- [ ] Kafka consumer in [service]
- [ ] End-to-end flow tests

### Phase 4: Rollout (Week 4-5)
- [ ] Feature flag setup (LaunchDarkly/config)
- [ ] Dark launch (0% traffic, monitoring only)
- [ ] Canary deployment (5% traffic)
- [ ] Gradual rollout (25% → 50% → 100%)
- [ ] Documentation and runbook
```

### Rollback Plan

```
### Immediate Rollback (< 5 minutes)
- Disable feature flag in [config location]
- Traffic immediately routes to old flow
- No deployment needed

### Code Rollback (< 30 minutes)
- Revert to previous Docker image: `[service]:[previous-tag]`
- Deploy command: `copilot svc deploy --tag [previous-version]`
- Verify health checks pass

### Data Rollback (if needed)
- Point-in-time recovery: RDS snapshot from [timestamp]
- Kafka offset reset: Consumer group reset to [offset/timestamp]
- Manual data cleanup script: [location]

### Rollback Triggers
- Error rate > 10% for 5 minutes
- P99 latency > 5 seconds
- Critical business metric drops > 20%
```

### Testing Strategy

```
### Unit Tests
- Coverage target: 80% line coverage minimum
- Focus areas: Business logic, validation, edge cases
- Framework: JUnit 5 + Mockito

### Integration Tests
- Database: Testcontainers with PostgreSQL
- Kafka: Testcontainers with Kafka
- External services: WireMock stubs
- Coverage: All API endpoints, happy + error paths

### End-to-End Tests
- Environment: QA/Staging
- Scenarios:
  - Happy path: [describe flow]
  - Error handling: [describe scenarios]
  - Timeout/retry: [describe scenarios]

### Performance Tests
- Tool: k6 / Gatling
- Target: [X] TPS sustained for 10 minutes
- Baseline: P99 < [Y]ms

### Chaos Testing (if applicable)
- Service failure simulation
- Network partition simulation
- Database failover
```

### Open Questions

List unresolved decisions that need team input:
```
1. **[Question about approach]**
   - Option A: [description] - Pros: X, Cons: Y
   - Option B: [description] - Pros: X, Cons: Y
   - Recommendation: [your suggestion]

2. **[Question about scope]**
   - Should we include [feature] in this RFC or defer?

3. **[Question about integration]**
   - How should we handle [edge case]?
```

### Prior Art / Alternatives Considered

Document what you evaluated and why you rejected it:
```
### Alternative 1: [Approach Name]
- Description: [How it would work]
- Pros: [Benefits]
- Cons: [Drawbacks]
- Why rejected: [Specific reason]

### Alternative 2: [Approach Name]
- Description: [How it would work]
- Pros: [Benefits]
- Cons: [Drawbacks]
- Why rejected: [Specific reason]

### Prior Art
- [Similar feature/system] in [company/project]: [What we learned]
- Industry standard approach: [Description and applicability]
```

### Security & Compliance

```
### Authentication
- User auth: Firebase JWT via app-gateway
- Service-to-service: Internal JWT / mTLS

### Authorization
- RBAC roles required: [list roles]
- Permission checks: [describe checks]
- Multi-tenant isolation: tenant_id in all queries

### Data Privacy
- PII fields: [list fields]
- Encryption at rest: AES-256 (RDS)
- Encryption in transit: TLS 1.2+
- Data masking in logs: [fields masked]

### Compliance
- OJK requirements: [if applicable]
- Data retention: [X] years for [data type]
- Audit trail: All mutations logged

### Threat Model (if applicable)
- [Threat]: [Mitigation]
```

### Performance Impact

```
### Latency Impact
| Operation | Current | Expected | Delta |
|-----------|---------|----------|-------|
| [API endpoint] | N/A (new) | P50: Xms, P99: Yms | - |
| [Modified endpoint] | P50: Xms | P50: X+Δms | +Δms |

### Throughput
- Expected TPS: [X] sustained, [Y] peak
- Bottleneck: [identify likely bottleneck]

### Resource Impact
| Service | CPU | Memory | DB Connections |
|---------|-----|--------|----------------|
| [service] | +X% | +Y MB | +Z |

### Scalability
- Horizontal scaling: [supported/considerations]
- Database scaling: [read replicas, sharding considerations]
```

### Monitoring & Observability

```
### Metrics (Datadog)
| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `[service].[feature].request.count` | Request volume | N/A (dashboard) |
| `[service].[feature].request.latency` | Response time | P99 > 2s |
| `[service].[feature].error.rate` | Error percentage | > 5% |
| `[service].[feature].success.rate` | Success rate | < 95% |

### Alerts
| Alert | Condition | Severity | Runbook |
|-------|-----------|----------|---------|
| High error rate | > 5% for 5 min | P2 | [link] |
| High latency | P99 > 2s for 10 min | P3 | [link] |
| Service down | Health check fails | P1 | [link] |

### Dashboards
- Feature dashboard: [Datadog link]
- Service dashboard: [Datadog link]

### Logs
- Structured logging via BWLogger
- Key fields for debugging: userId, transactionId, requestId, [feature-specific]
- Log queries for common issues: [examples]
```

### Appendix

Include supporting materials:
```
### Database Schema
[Full CREATE TABLE statements]

### API Specifications
[OpenAPI/Swagger snippets]

### Kafka Event Schemas
[Full JSON schemas]

### Configuration Examples
[Environment variables, feature flags]

### Sequence Diagrams
[Detailed Mermaid/PlantUML diagrams]

### Glossary
[Domain-specific terms]
```

---

## Service-Specific Considerations

### When Modifying multi-tenant-auth
- Consider impact on all downstream services (everyone depends on it)
- JWT token structure changes affect all services
- Coordinate rollout with all teams
- Test thoroughly in staging with real service dependencies

### When Modifying payments
- Payment flow changes require extensive testing
- Idempotency is critical for all payment operations
- Consider reconciliation and accounting impact
- Coordinate with finance team for any ledger changes

### When Modifying banking
- External bank API changes need provider coordination
- Callback handling must be idempotent
- Consider retry and timeout scenarios carefully

### When Adding Kafka Events
- Register schema with team (schema registry if used)
- Ensure backward compatibility for consumers
- Plan for consumer lag during high volume
- Consider dead letter queue for failed processing

### When Modifying Database Schema
- Always use Flyway migrations
- Ensure zero-downtime deployment compatibility
- Plan for data backfill if adding non-nullable columns
- Consider read replica lag for critical queries

---

## RFC Review Checklist

Before submitting RFC for review:

- [ ] All affected services identified in Architecture Overview
- [ ] Data flow covers happy path and error scenarios
- [ ] API changes documented with request/response schemas
- [ ] Database migrations specified with rollback scripts
- [ ] Kafka events defined with full schemas
- [ ] Health monitoring and failover logic documented
- [ ] Rollback plan is actionable and tested
- [ ] Testing strategy covers unit, integration, and e2e
- [ ] Open questions are clearly stated with options
- [ ] Alternatives considered with clear rejection reasons
- [ ] Security and compliance requirements addressed
- [ ] Performance impact estimated with metrics
- [ ] Monitoring dashboards and alerts defined
- [ ] Implementation phases are realistic with dependencies
