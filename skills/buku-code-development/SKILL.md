---
name: buku-code-development
description: >
  Java coding workflow for BukuWarung microservices. Use when implementing features,
  writing code, fixing bugs, or making code changes across BUKU's Java 8-21 Spring Boot
  services. Covers patterns (auth, error handling, Kafka, JPA, Resilience4j), code
  conventions, project structure (layered and hexagonal), build commands, and testing.
  Do NOT use for architecture questions (use buku skill) or RFC generation
  (use buku-rfc-generation skill).
---

# Code Development Skill

## Workflow

```
Task → Find Services → Check Patterns → Write Code → Test → Pre-Push Check → Push
```

> **⚠️ Never `git push` without running the Pre-Push Check (Step 8).**
> Build failures in CI waste reviewer time and block merges. If the local build fails, fix it — do not push and hope.

---

## Pre-Push Check (MANDATORY before every push)

Run these **in order**, from the repo root, and only push when all pass. If any step fails, fix the root cause — do not push with `--no-verify`, do not comment-out tests, do not suppress compile errors.

> ### 📋 Auto-heal cheatsheet — what to do when a step fails
>
> Before escalating, try the mechanical remediation. Most BUKU build failures map 1-to-1 to a fix:
>
> | Failure signal in build output                                                  | Auto-heal                                                                       | Then re-run                              |
> | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------- |
> | `spotlessJavaCheck FAILED` / `The following files had format violations`        | `./gradlew spotlessApply`  (Maven: `mvn spotless:apply`)                        | `./gradlew spotlessCheck` — must be green |
> | `checkstyleMain FAILED` / `Checkstyle rule violated`                            | Apply the rule the check names (usually import order / line length)             | `./gradlew checkstyleMain`               |
> | `cannot find symbol` / `package X does not exist` in a loader-variant source set | Import lives in the wrong source set — move or re-scope; never cross `net.minecraftforge.*` into a Fabric source set | `./gradlew clean compileJava*`           |
> | `unmappedMethodAccess` / `unmappedFieldAccess`                                  | Re-resolve against the current source set's mappings (don't copy names across mapping sets) | `./gradlew compileJava*`                  |
> | Lombok `getX()` / `builder()` missing on a POJO                                 | Add `lombok` to that source set's `annotationProcessor` configuration            | Recompile                                |
> | Flyway version clash (`FlywayValidateException: Detected resolved migration not applied`) | Rename your migration to the next monotonic `V{YYYYMMDD}{seq}__*.sql` — never edit an already-applied migration | `./gradlew flywayInfo`                   |
> | `ClassNotFoundException` / `Package ... is not exported` at test time           | Add the missing dependency to the right source set (`implementation` vs `testImplementation` vs per-variant config) | `./gradlew test`                          |
> | `-Pfabric` / `-Pforge` task compiles but fails on the other loader              | You edited code that lives in *both* loader source sets and only tested one — run `./gradlew tasks --all \| grep -i '^compile'` to list every compile task, run all of them | All compile tasks green                  |
> | `ResolveException: Could not resolve <artifact>`                                 | Dependency missing or versioned incorrectly — diff `build.gradle(.kts)` with `origin/main` and reconcile; don't delete the dep to silence the error | `./gradlew --refresh-dependencies build` |
> | CI red but laptop green                                                          | Compare compile tasks between CI YAML and your local — CI is compiling a source set you skipped. Run it locally, reproduce, fix | Push again only after local reproduces CI |
>
> **Rules for auto-healing:**
> 1. Run the heal command from the **repo root**, not inside a sub-module.
> 2. Commit the auto-healed files **separately** from the functional change (`git add <files> && git commit -m "chore: spotlessApply"`) so the diff stays reviewable.
> 3. After healing, **re-run the original failing command** — don't just proceed.
> 4. If the same failure re-appears after a heal, stop and investigate the root cause. Don't loop.
> 5. Never delete a test, suppress a rule, or `-x` a task to make the build green.

### 1. Format
| Build Tool | Command |
|------------|---------|
| Gradle | `./gradlew spotlessApply` |
| Maven  | `mvn spotless:apply` |

Commit any formatting changes separately so the diff stays readable.

**If `spotlessJavaCheck` fails during the compile step, come back here** — run `./gradlew spotlessApply`, stage the reformatted files, commit as `chore: spotlessApply`, then re-run `./gradlew spotlessCheck` to confirm green. Only then move on.

### 2. Full compile — all source sets
A green `build` on your laptop is not enough; CI compiles **every** source set (main, test, and any loader-specific sets like `fabric`, `forge`, `neoforge`, integration tests). Run:

```bash
# Gradle — compiles every source set in every subproject
./gradlew clean compileJava compileTestJava check --no-daemon

# If the repo has loader/variant source sets (e.g. Fabric/Forge, or Spring profiles
# producing separate source sets), compile them explicitly:
./gradlew compileJavaFabric compileJavaForge compileIntegrationTestJava 2>/dev/null || true
./gradlew tasks --all | grep -i '^compile' # discover compile tasks for this repo

# Maven
mvn -B clean verify -DskipITs=false
```

**Common failures and how to fix them (do not just silence the error):**
- `cannot find symbol` / `package X does not exist` → you imported from the wrong module or left an unmapped import. For multi-module or multi-loader projects, confirm the class exists in the source set you're compiling. A `net.minecraftforge.*` import inside a Fabric source set (or vice-versa) is always a bug.
- `unmappedMethodAccess` / `unmappedFieldAccess` → you called a method name from another mapping set. Re-resolve against the current source set's mappings.
- Generated sources missing → run the generator task first (`./gradlew generateSources` or equivalent) and do not commit references to generated classes without committing the generator config.
- Lombok errors → confirm `lombok` is on the `annotationProcessor` configuration for every source set that uses it.

### 3. Tests
```bash
./gradlew test           # unit
./gradlew integrationTest 2>/dev/null || true
mvn test                 # Maven
```
No skipped tests, no `@Disabled` added to make red tests green. If a test is legitimately broken by your change, update the test to assert the new behavior and explain why in the commit message.

### 4. Static checks / linters the repo ships with
```bash
./gradlew spotlessCheck checkstyleMain pmdMain spotbugsMain 2>/dev/null || true
mvn spotless:check checkstyle:check 2>/dev/null || true
```
Only skip a check with a repo-approved suppression file, never with `-x`.

### 5. Secrets & config
- `git diff --staged` — scan for tokens, keys, `.env` values, `bootstrap.yml` hard-coded creds.
- No `System.out.println` / stray `println` / `e.printStackTrace()` — use `log.info/warn/error` with structured BWLogger fields (`userId`, `transactionId`, `requestId`).
- No commented-out code blocks. Delete them.

### 6. Migration sanity (if Flyway/Liquibase changed)
- Filename matches `V{YYYYMMDD}{seq}__description.sql`, monotonic with existing migrations.
- Idempotent where possible (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).
- `./gradlew flywayInfo` / `mvn flyway:info` runs clean against a fresh DB.

### 7a. Coding-practice self-review
Before pushing, re-read your diff and confirm:
- **Every new public method** has Javadoc or is obviously self-explanatory from name + types.
- **No swallowed exceptions** (`catch (Exception e) {}` without at minimum a log + rethrow/wrap).
- **No `Optional.get()` without `isPresent()` / `orElseThrow()`**.
- **DI style matches the service** — use constructor injection (`@RequiredArgsConstructor`) for new code **unless** the service's local convention is `@Autowired` fields (confirm via Step 4.5; e.g. BNPL uses field injection).
- **All external calls** wrapped with `@CircuitBreaker` + `@Retry` where appropriate.
- **Auth**: every new controller method validates the JWT actor (or is explicitly `/public/**`).
- **Error handling**: throws `BusinessException`/`ResourceNotFoundException` with a code from the standard set, not a raw `RuntimeException`.
- **Kafka events**: include `eventId`, `eventType`, `timestamp`, and are backward-compatible (only additive schema changes).
- **DB access**: goes through a repository, never raw JDBC in a controller/service.
- **Tests**: new behavior has at least one unit test; bug fixes have a regression test that fails before the fix.

### 7b. ⚠️ MANDATORY design self-review (clean-code / OOP)

PRs that pass the build but read poorly still draw 5–6 Clean-Code/OOP comments. This is a
**coaching pass you must perform**, not a redundant hard gate — SonarQube still enforces
metrics post-PR. Re-read your diff against `references/clean-code.md` and confirm each box.
Where a threshold is given it is **objective** — apply it literally.

- [ ] **(A) Single Responsibility** — every changed class is describable in one sentence with no "and". → `references/clean-code.md` §A
- [ ] **(B) Method complexity** — no method body `> 25 lines` or `> 3` nesting levels. → §B
- [ ] **(C) Extract Method + naming** — no comment narrates code that should be a named method; no naked magic numbers. → §C
- [ ] **(D) DRY** — no block duplicated `≥ 3` times; shared shape extracted. → §D
- [ ] **(E) Guard clauses** — negative cases return/throw early; the happy path is flat (≤ 1 indent). → §E
- [ ] **(F) Composition over inheritance** — no base class used purely to share a helper; strategies are composed/injected. → §F
- [ ] **(G) Intention-revealing tests** — every new test has a behaviour-naming name and Arrange/Act/Assert structure. → §G
- [ ] **Local convention conformance** — the change matches the target repo's conventions read in Step 4.5.

**If any box fails, refactor NOW — before pushing. Do not push-and-ask the reviewer to flag it.**

> **Rule-vs-framework conflict:** If a clean-code rule above would conflict with a framework
> idiom or local convention the service already uses (e.g. BNPL's `@Autowired` field injection,
> the Brick `EventAuditUtil` 4-step audit), **keep the local convention**, document the
> trade-off in your PR description, and ask the reviewer/architect if you believe the
> convention itself should change. Do not silently "fix" the framework idiom.

### 8. Only now: push
```bash
git status          # clean except for intended files
git log --oneline origin/$(git branch --show-current)..HEAD  # sanity-check commits
git push
```

If CI is still red after all of the above passes locally, the first thing to check is that CI is compiling the same source sets as your local run — not that CI is "flaky".

---


### Step 1: Understand the Task

Identify:
- Which service(s) need changes
- Type of change: new feature, bug fix, refactor, integration
- Scope: single service vs cross-service

### Step 2: Find Relevant Services

Use `references/architecture.md` (via `buku` skill) to locate services:

| Task Type | Services |
|-----------|----------|
| Auth, login, OTP | multi-tenant-auth, notification |
| Payments | payments, banking, accounting-service |
| KYC | janus, kyc-liveliness, user-trust |
| Loans, BNPL | los-lender, fs-bnpl-service, lms-client |
| Digital products | finpro, digital-product-adapter |
| E-commerce | tokoko-service |
| Loyalty | loyalty |
| Risk | risk, user-trust |
| Rules | rule-engine |
| EDC, terminals | edc-adapter, miniatm-backend |
| QRIS | retail-backend |
| Analytics | dracula-v2, data-analytics, transaction-history |

Check `references/code-conventions.md` for naming and structure standards.

### Step 3: Identify Tech Stack

| Java Version | Services |
|--------------|----------|
| **Java 21** | multi-tenant-auth, dracula-v2, miniatm-backend, retail-backend |
| **Java 17** | transaction-history, edc-adapter, rafana |
| **Java 11** | los-lender, risk, banking, janus, golden-gate, fs-bnpl-service |
| **Java 8** | accounting-service, payments, finpro, loyalty, data-analytics |

| Framework | Services |
|-----------|----------|
| **Reactive (WebFlux)** | banking, miniatm-backend, retail-backend, transaction-history, lms-client |
| **Traditional (MVC)** | Most other services |
| **Hexagonal** | los-lender, finpro, janus, edc-adapter, miniatm-backend, retail-backend |

| Build Tool | Services |
|------------|----------|
| **Gradle** | Most newer services |
| **Maven** | accounting-service, payments, finpro, janus |
| **Yarn** | panacea, los-web |

### Step 4: Follow Patterns

Reference `references/patterns.md` for:

#### Authentication
```java
// JWT from app-gateway, validate with multi-tenant-auth
@GetMapping("/api/v1/resource")
public ResponseEntity<?> get(@RequestHeader("Authorization") String token) {
    // Token already validated by gateway
    String userId = jwtUtil.extractUserId(token);
}
```

#### Error Handling
```java
// Use Zalando Problem, standard error codes
throw new BusinessException("AUTH_401", "Invalid token");
throw new ResourceNotFoundException("NOT_FOUND_404", "User not found");
```

#### Kafka Events
```java
// Spring Cloud Stream with StreamBridge
streamBridge.send("payments", PaymentEvent.builder()
    .eventId(UUID.randomUUID().toString())
    .eventType("payment.transaction.completed")
    .timestamp(Instant.now())
    .data(paymentData)
    .build());
```

#### Database
```java
// JPA with audit fields
@Entity
@Table(name = "transactions")
public class Transaction {
    @Id
    private String id;

    @Column(name = "created_at")
    private LocalDateTime createdAt;

    @PrePersist
    void onCreate() {
        this.createdAt = LocalDateTime.now();
    }
}
```

#### Resilience
```java
// Resilience4j circuit breaker
@CircuitBreaker(name = "externalService", fallbackMethod = "fallback")
@Retry(name = "externalService")
public Response callExternal() { }
```

### Step 4.5: Read the Target Repo's Conventions (MANDATORY)

**Before writing any code, conform to the local repo, not just the generic patterns above.**
A change that ignores the service's local conventions attracts review comments even when it
"works". Do this for every service you touch:

1. **Read the repo's `CLAUDE.md`** (or `AGENTS.md` / `CONTRIBUTING.md`) at the repo root if it
   exists — it is the authoritative source for that service's local rules and overrides
   anything generic.
2. **When there is no such file, sample real classes** in
   `src/main/java/com/bukuwarung/<service>/` — read 2–3 existing classes of the *same kind*
   you are about to write (a controller if adding a controller; a `…ServiceImpl` if adding a
   service; the matching adapter for hexagonal services) plus their tests.
3. **Extract and conform to** the local choices, e.g.:
   - DI style — constructor injection (`@RequiredArgsConstructor`) vs `@Autowired` fields.
     These differ **per service** (Brick uses constructor injection; BNPL uses `@Autowired`
     fields — see `references/implementation-best-practices.md` §7).
   - Lombok on entities — `@Data` vs `@Setter @Getter`.
   - Response style — `ResponseEntity<?>` direct object vs typed `ResponseEntity<T>`.
   - Mandatory cross-cutting patterns — e.g. the Brick `EventAuditUtil` 4-step audit, MDC
     logging, `@RequestAttribute("x-request-id")`.
   - DTO package layout, naming suffixes, test framework (`@WebMvcTest` vs
     `@ExtendWith(MockitoExtension.class)`).

**The local convention wins over the generic example in these references.** If a local
convention conflicts with a clean-code rule (see `references/clean-code.md`), keep the local
convention, note the trade-off in your PR description, and ask the reviewer/architect if the
convention itself should change.

### Step 5: Use Code Templates

Reference `references/code-examples.md` for copy-paste templates:

1. REST Controller (MVC)
2. Service Layer
3. Repository Layer
4. Feign Client
5. Kafka Producer
6. Kafka Consumer
7. Exception Handling
8. Entity with Audit
9. DTO with Validation
10. Reactive Controller (WebFlux)
11. Reactive Repository (R2DBC)
12. Circuit Breaker
13. Redis Caching
14. Flyway Migration
15. Unit Test
16. Integration Test

### Step 6: Apply Conventions

Reference `references/code-conventions.md` for:

#### Project Structure (Layered)
```
src/main/java/com/bukuwarung/[service]/
├── config/
├── controller/
├── dto/
├── entity/
├── exception/
├── mapper/
├── repository/
├── service/
└── util/
```

#### Project Structure (Hexagonal)
```
src/main/java/com/bukuwarung/[service]/
├── app/
├── core/
│   ├── domain/
│   ├── port/
│   └── service/
├── adapters/
│   ├── api/
│   ├── persistence/
│   └── provider/
└── common/
```

#### Naming
- Package: `com.bukuwarung.[service].[layer]`
- Class: `PascalCase` + suffix (`Service`, `Controller`, `Repository`)
- Method: `camelCase`, verb-first (`findById`, `processPayment`)
- Constant: `UPPER_SNAKE_CASE`
- Database table: `snake_case`, plural (`transactions`, `user_accounts`)
- API endpoint: `/api/v1/[resource]`
- Kafka topic: `{domain}.{entity}.{action}`

#### Code Style
- Google Java Format via Spotless
- Gradle: `./gradlew spotlessApply`
- Maven: `mvn spotless:apply`

#### Lombok
```java
@Data                    // Getters, setters, toString, equals, hashCode
@Builder                 // Builder pattern
@NoArgsConstructor       // Default constructor
@AllArgsConstructor      // All-args constructor
@RequiredArgsConstructor // Final fields constructor
@Slf4j                   // Logger
@Value                   // Immutable class
```

### Step 7: Write Tests

#### Unit Test
```java
@ExtendWith(MockitoExtension.class)
class PaymentServiceTest {
    @Mock
    private PaymentRepository repository;

    @InjectMocks
    private PaymentServiceImpl service;

    @Test
    void shouldProcessPayment() {
        // Arrange
        // Act
        // Assert
    }
}
```

#### Integration Test
```java
@SpringBootTest
@Testcontainers
class PaymentIntegrationTest {
    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:14");

    @Test
    void shouldSavePayment() { }
}
```

---

## Common Tasks

### Add New API Endpoint

1. Create DTO in `dto/` with validation
2. Create/update Service interface and implementation
3. Create/update Repository if DB access needed
4. Add Controller method with OpenAPI annotations
5. Add unit tests
6. Add integration tests
7. Update gateway routes if needed (see `buku` skill → `references/gateway-routes.md`)

### Add Kafka Producer

1. Add Spring Cloud Stream dependency
2. Configure topic in `application.yml`
3. Create event DTO
4. Inject `StreamBridge` and send events
5. Add integration test with embedded Kafka

### Add Kafka Consumer

1. Configure consumer in `application.yml`
2. Create consumer function bean
3. Handle idempotency (check if already processed)
4. Add error handling and DLQ
5. Add integration test

### Add Feign Client

1. Create client interface with `@FeignClient`
2. Define request/response DTOs
3. Add error decoder
4. Configure timeout and retry
5. Add circuit breaker

### Add Database Table

1. Create Flyway migration: `V{YYYYMMDD}{seq}__description.sql`
2. Create JPA entity with audit fields
3. Create repository interface
4. Add indexes for query patterns

---

## Cross-Service Development

When changes span multiple services:

1. **Identify all services** using `references/architecture.md` (via `buku` skill)
2. **Check dependencies** - which calls which?
3. **Plan rollout order** - dependencies first
4. **Coordinate Kafka schemas** - backward compatible
5. **Test integration** - e2e across services

Key integration points:
```
All services     → multi-tenant-auth (auth)
payments         → rule-engine (routing)
lending          → janus (KYC), risk (credit)
Many services    → notification (alerts)
Many services    → dracula-v2 (events)
```

---

## Build & Deploy

| Tool | Command |
|------|---------|
| Gradle build | `./gradlew build` |
| Gradle test | `./gradlew test` |
| Gradle format | `./gradlew spotlessApply` |
| Maven build | `mvn clean package` |
| Maven test | `mvn test` |
| Maven format | `mvn spotless:apply` |

---

## Additional References

- `references/clean-code.md` — Clean-Code / OOP design self-review (sections A–G) with objective thresholds and Java BEFORE/AFTER snippets; backs Pre-Push Step 7b.
- `references/reasoning.md` — 12 architectural decisions with rationale for the lending services (why Java Spring Boot, why separate services, 4-step audit pattern, etc.)
- `references/implementation-best-practices.md` — Detailed implementation patterns for BNPL and Brick service tickets

---

## Debugging Tips

1. Check logs with BWLogger fields: `userId`, `transactionId`, `requestId`
2. Trace Kafka events by `eventId`
3. Check circuit breaker state in `/actuator/health`
4. Review Datadog dashboards for service metrics
5. Check gateway routes (via `buku` skill → `references/gateway-routes.md`) for routing issues
