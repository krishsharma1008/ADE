# Code Conventions

Coding standards and conventions used across BukuWarung services.

---

## Project Structure

### Standard Java Service (Layered)

```
service-name/
├── src/main/java/com/bukuwarung/servicename/
│   ├── config/           # Configuration classes
│   ├── controller/       # REST API controllers
│   ├── dto/              # Data transfer objects (request/response)
│   ├── entity/           # JPA entities
│   ├── enums/            # Enumeration types
│   ├── exception/        # Custom exceptions
│   ├── filter/           # Request/response filters
│   ├── mapper/           # MapStruct mappers
│   ├── repository/       # Data access layer
│   ├── service/          # Business logic
│   └── util/             # Utility classes
├── src/main/resources/
│   ├── application.yml
│   ├── application-local.yml
│   └── db/migration/     # Flyway migrations
├── src/test/java/
└── deployments/          # Kubernetes configs
```

### Hexagonal Architecture (Ports & Adapters)

Used in: los-lender, finpro, janus, edc-adapter, miniatm-backend, retail-backend

```
service-name/
├── app/                  # Application entry point
├── core/                 # Domain logic (no external dependencies)
│   ├── domain/           # Domain entities and value objects
│   ├── port/             # Interfaces (ports)
│   │   ├── in/           # Inbound ports (use cases)
│   │   └── out/          # Outbound ports (repositories, clients)
│   └── service/          # Domain services
├── adapters/
│   ├── api/              # REST controllers (inbound adapter)
│   ├── persistence/      # Database (outbound adapter)
│   └── provider/         # External services (outbound adapter)
├── common/               # Shared utilities
└── deployments/
```

### Multi-Module Maven/Gradle

Used in: accounting-service, payments, notification, loyalty

```
service-name/
├── service-commons/      # Shared DTOs and utilities
├── service-dao/          # Data access layer
├── service-service/      # Business logic
├── service-web/          # REST API controllers
├── service-outbound/     # External integrations
├── service-worker/       # Background job processing (if applicable)
└── pom.xml / build.gradle
```

---

## Naming Conventions

### Java

| Element | Convention | Example |
|---------|------------|---------|
| Package | lowercase, domain-based | `com.bukuwarung.payments.service` |
| Class | PascalCase | `PaymentService`, `UserRepository` |
| Interface | PascalCase | `PaymentProcessor`, `UserRepository` |
| Method | camelCase, verb-first | `processPayment()`, `findByUserId()` |
| Variable | camelCase | `userId`, `transactionAmount` |
| Constant | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT`, `DEFAULT_TIMEOUT` |
| Enum | PascalCase class, UPPER_SNAKE_CASE values | `PaymentStatus.COMPLETED` |

### Class Naming by Type

| Type | Suffix | Example |
|------|--------|---------|
| Controller | `Controller` | `PaymentController` |
| Service | `Service` or `ServiceImpl` | `PaymentService`, `PaymentServiceImpl` |
| Repository | `Repository` | `PaymentRepository` |
| Entity | (none) | `Payment`, `User` |
| DTO | `Request`, `Response`, `Dto` | `PaymentRequest`, `UserResponse` |
| Mapper | `Mapper` | `PaymentMapper` |
| Exception | `Exception` | `PaymentFailedException` |
| Config | `Config` or `Configuration` | `KafkaConfig`, `SecurityConfiguration` |
| Client | `Client` | `NotificationClient`, `JanusClient` |

### Database

| Element | Convention | Example |
|---------|------------|---------|
| Table | snake_case, plural | `payments`, `user_transactions` |
| Column | snake_case | `user_id`, `created_at` |
| Primary Key | `id` | `id` |
| Foreign Key | `{referenced_table}_id` | `user_id`, `payment_id` |
| Index | `idx_{table}_{columns}` | `idx_payments_user_id` |
| Unique Constraint | `uk_{table}_{columns}` | `uk_users_email` |

### API Endpoints

| Pattern | Example |
|---------|---------|
| Resource collection | `GET /api/v1/payments` |
| Single resource | `GET /api/v1/payments/{id}` |
| Create resource | `POST /api/v1/payments` |
| Update resource | `PUT /api/v1/payments/{id}` |
| Partial update | `PATCH /api/v1/payments/{id}` |
| Delete resource | `DELETE /api/v1/payments/{id}` |
| Action on resource | `POST /api/v1/payments/{id}/refund` |
| Nested resource | `GET /api/v1/users/{userId}/transactions` |

### Kafka Topics

```
{domain}.{entity}.{action}

Examples:
- payments.transaction.completed
- user.account.created
- lending.loan.approved
```

---

## Code Style

### Java Code Style

All services use **Google Java Format** via Spotless plugin.

**Gradle:**
```bash
./gradlew spotlessApply   # Apply formatting
./gradlew spotlessCheck   # Check formatting
```

**Maven:**
```bash
mvn spotless:apply        # Apply formatting
mvn spotless:check        # Check formatting
```

### Key Style Rules

```java
// 1. Imports - no wildcards, sorted
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.springframework.stereotype.Service;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

// 2. Class structure
@Service
@RequiredArgsConstructor
@Slf4j
public class PaymentService {

    // Constants first
    private static final int MAX_RETRIES = 3;

    // Dependencies (final, injected via constructor)
    private final PaymentRepository paymentRepository;
    private final NotificationClient notificationClient;

    // Public methods
    public PaymentResponse processPayment(PaymentRequest request) {
        // Implementation
    }

    // Private methods at the bottom
    private void validateRequest(PaymentRequest request) {
        // Implementation
    }
}
```

### Lombok Usage

Recommended annotations:

```java
@Data                    // Getters, setters, equals, hashCode, toString
@Builder                 // Builder pattern
@NoArgsConstructor       // Required for JPA entities
@AllArgsConstructor      // For @Builder
@RequiredArgsConstructor // Constructor injection for final fields
@Slf4j                   // Logger
@Value                   // Immutable data classes
```

### Optional Usage

```java
// Good - use Optional for return types that might be absent
public Optional<User> findByEmail(String email) {
    return userRepository.findByEmail(email);
}

// Good - handle Optional properly
User user = userService.findByEmail(email)
    .orElseThrow(() -> new ResourceNotFoundException("User", email));

// Bad - don't use Optional as method parameter
// void processUser(Optional<String> email) // Don't do this
```

---

## API Design

### Request/Response DTOs

```java
// Request DTO
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CreatePaymentRequest {

    @NotBlank(message = "User ID is required")
    private String userId;

    @NotNull(message = "Amount is required")
    @Positive(message = "Amount must be positive")
    private BigDecimal amount;

    @NotBlank(message = "Payment method is required")
    private String paymentMethod;

    private Map<String, String> metadata;
}

// Response DTO
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PaymentResponse {

    private String paymentId;
    private String userId;
    private BigDecimal amount;
    private PaymentStatus status;
    private Instant createdAt;
    private String message;
}
```

### Controller Structure

```java
@RestController
@RequestMapping("/api/v1/payments")
@RequiredArgsConstructor
@Slf4j
@Tag(name = "Payments", description = "Payment operations")
public class PaymentController {

    private final PaymentService paymentService;

    @PostMapping
    @Operation(summary = "Create a new payment")
    @ApiResponses({
        @ApiResponse(responseCode = "201", description = "Payment created"),
        @ApiResponse(responseCode = "400", description = "Invalid request"),
        @ApiResponse(responseCode = "500", description = "Internal error")
    })
    public ResponseEntity<PaymentResponse> createPayment(
            @Valid @RequestBody CreatePaymentRequest request) {
        
        PaymentResponse response = paymentService.createPayment(request);
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }

    @GetMapping("/{paymentId}")
    @Operation(summary = "Get payment by ID")
    public ResponseEntity<PaymentResponse> getPayment(
            @PathVariable String paymentId) {
        
        return paymentService.findById(paymentId)
            .map(ResponseEntity::ok)
            .orElse(ResponseEntity.notFound().build());
    }

    @GetMapping
    @Operation(summary = "List payments")
    public ResponseEntity<Page<PaymentResponse>> listPayments(
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String userId) {
        
        Pageable pageable = PageRequest.of(page, size, Sort.by("createdAt").descending());
        Page<PaymentResponse> payments = paymentService.findAll(userId, pageable);
        return ResponseEntity.ok(payments);
    }
}
```

### API Versioning

BukuWarung uses URL path versioning:

```
/api/v1/auth/**   # Version 1
/api/v2/auth/**   # Version 2
/api/v3/auth/**   # Version 3 (latest)
```

---

## Configuration

### Application Properties

```yaml
# application.yml
spring:
  application:
    name: payment-service
  datasource:
    url: ${DB_URL}
    username: ${DB_USERNAME}
    password: ${DB_PASSWORD}
  jpa:
    hibernate:
      ddl-auto: validate
    properties:
      hibernate:
        dialect: org.hibernate.dialect.PostgreSQLDialect

server:
  port: ${SERVER_PORT:8080}

# Custom service configuration
payment:
  max-retry-attempts: ${PAYMENT_MAX_RETRIES:3}
  timeout-seconds: ${PAYMENT_TIMEOUT:30}
```

### Environment Variables

**Never hardcode credentials or environment-specific values.**

| Type | Convention | Example |
|------|------------|---------|
| Database | `DB_*` | `DB_URL`, `DB_USERNAME` |
| Service URLs | `{SERVICE}_SERVICE_URL` | `NOTIFICATION_SERVICE_URL` |
| API Keys | `{SERVICE}_API_KEY` | `XENDIT_API_KEY` |
| Feature Flags | `FEATURE_*` | `FEATURE_NEW_FLOW_ENABLED` |
| Timeouts | `{SERVICE}_TIMEOUT` | `PAYMENT_TIMEOUT` |

### Secrets Management

Use AWS Secrets Manager for sensitive data:

```java
// Via Spring Cloud AWS
@Value("${payment.provider.api-key}")
private String apiKey;

// application.yml
payment:
  provider:
    api-key: ${aws-secretsmanager:payment-service/api-key}
```

---

## Documentation

### Swagger/OpenAPI

All REST APIs must be documented:

```java
@Operation(
    summary = "Process payment",
    description = "Creates and processes a new payment transaction"
)
@ApiResponses({
    @ApiResponse(
        responseCode = "201",
        description = "Payment created successfully",
        content = @Content(schema = @Schema(implementation = PaymentResponse.class))
    ),
    @ApiResponse(
        responseCode = "400",
        description = "Invalid request",
        content = @Content(schema = @Schema(implementation = ProblemDetail.class))
    )
})
@PostMapping
public ResponseEntity<PaymentResponse> processPayment(
        @Parameter(description = "Payment details") 
        @Valid @RequestBody PaymentRequest request) {
    // ...
}
```

### Code Comments

```java
/**
 * Processes a payment transaction through the configured payment provider.
 *
 * <p>This method handles:
 * <ul>
 *   <li>Validation of payment request</li>
 *   <li>Provider selection based on payment method</li>
 *   <li>Transaction recording</li>
 *   <li>Notification dispatch</li>
 * </ul>
 *
 * @param request the payment request containing amount, user, and method
 * @return the payment response with transaction details
 * @throws PaymentFailedException if the payment could not be processed
 * @throws ValidationException if the request is invalid
 */
public PaymentResponse processPayment(PaymentRequest request) {
    // Implementation
}
```

---

## Git Conventions

### Branch Naming

```
feature/{ticket-id}-{short-description}
bugfix/{ticket-id}-{short-description}
hotfix/{ticket-id}-{short-description}
release/{version}

Examples:
feature/PAY-123-add-qris-support
bugfix/AUTH-456-fix-otp-expiry
hotfix/PAY-789-fix-disbursement-timeout
```

### Commit Messages

```
{type}: {short description}

{optional body}

{optional footer with ticket reference}

Types:
- feat: New feature
- fix: Bug fix
- refactor: Code refactoring
- docs: Documentation
- test: Adding tests
- chore: Maintenance

Examples:
feat: add QRIS payment support

fix: resolve OTP expiry calculation bug

refactor: extract payment provider selection logic
```

### Pull Request Guidelines

1. One PR per task (use squash merge)
2. Include ticket reference in PR title
3. Ensure all tests pass
4. Run code formatter before pushing
5. Update documentation if applicable
6. Request review from relevant team members

---

## Testing Standards

### Test Coverage Requirements

- Minimum 80% line coverage for new code
- All critical business logic must have unit tests
- Integration tests for external service interactions

### Test File Naming

```
{ClassName}Test.java           # Unit tests
{ClassName}IntegrationTest.java # Integration tests
```

### Test Structure (AAA Pattern)

```java
@Test
void shouldProcessPaymentSuccessfully() {
    // Arrange (Given)
    PaymentRequest request = createValidRequest();
    when(providerClient.process(any())).thenReturn(successResponse());
    
    // Act (When)
    PaymentResponse response = paymentService.process(request);
    
    // Assert (Then)
    assertThat(response.getStatus()).isEqualTo(PaymentStatus.SUCCESS);
    verify(notificationClient).sendConfirmation(any());
}

@Test
void shouldThrowExceptionWhenAmountIsNegative() {
    // Arrange
    PaymentRequest request = createRequestWithAmount(new BigDecimal("-100"));
    
    // Act & Assert
    assertThatThrownBy(() -> paymentService.process(request))
        .isInstanceOf(ValidationException.class)
        .hasMessageContaining("Amount must be positive");
}
```
