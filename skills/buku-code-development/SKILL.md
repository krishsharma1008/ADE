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
Task → Find Services → Check Patterns → Write Code → Test
```

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

- `references/reasoning.md` — 12 architectural decisions with rationale for the lending services (why Java Spring Boot, why separate services, 4-step audit pattern, etc.)
- `references/implementation-best-practices.md` — Detailed implementation patterns for BNPL and Brick service tickets

---

## Debugging Tips

1. Check logs with BWLogger fields: `userId`, `transactionId`, `requestId`
2. Trace Kafka events by `eventId`
3. Check circuit breaker state in `/actuator/health`
4. Review Datadog dashboards for service metrics
5. Check gateway routes (via `buku` skill → `references/gateway-routes.md`) for routing issues
