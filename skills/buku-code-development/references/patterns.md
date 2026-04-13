# Common Patterns

Standard patterns used across BukuWarung services. Follow these for consistency.

---

## Authentication Pattern

### Gateway Authentication

The `app-gateway` handles initial authentication using Firebase:

```
Client Request
     │
     ▼
┌─────────────────┐
│   App Gateway   │
│                 │
│ • Firebase Auth │
│ • Rate Limiting │
│ • Route to svc  │
└────────┬────────┘
         │
         ▼
   Target Service
```

### JWT Token Structure

Tokens issued by `multi-tenant-auth` contain:

```json
{
  "sub": "user_id",
  "tenant_id": "tenant_uuid",
  "roles": ["USER", "MERCHANT"],
  "permissions": ["read:transactions", "write:payments"],
  "exp": 1234567890,
  "iat": 1234567800
}
```

### Service-to-Service Authentication

When calling another service internally:

```java
// Using OpenFeign with auth token propagation
@FeignClient(name = "janus-service", url = "${JANUS_SERVICE_URL}")
public interface JanusClient {
    
    @GetMapping("/janus/api/kyc/status/{userId}")
    KycStatusResponse getKycStatus(
        @PathVariable String userId,
        @RequestHeader("Authorization") String token
    );
}
```

### Token Validation Pattern

Services validate tokens by calling multi-tenant-auth:

```java
// Typically handled by Spring Security filter
// Token validation endpoint: GET /api/v3/auth/validate
```

---

## Error Handling Pattern

### Standard Error Response

All services must return errors in this format:

```json
{
  "timestamp": "2024-01-20T10:30:00Z",
  "status": 400,
  "error": "Bad Request",
  "message": "Phone number is invalid",
  "path": "/api/v3/auth/otp/send",
  "code": "VALIDATION_ERROR",
  "details": {
    "field": "phoneNumber",
    "rejectedValue": "123"
  }
}
```

### Error Handling in Controllers

```java
// Using Zalando Problem (common in BW services)
@RestControllerAdvice
public class GlobalExceptionHandler implements ProblemHandling {

    @ExceptionHandler(BusinessException.class)
    public ResponseEntity<Problem> handleBusinessException(BusinessException ex) {
        return ResponseEntity
            .status(ex.getStatus())
            .body(Problem.builder()
                .withStatus(ex.getStatus())
                .withTitle(ex.getTitle())
                .withDetail(ex.getMessage())
                .with("code", ex.getErrorCode())
                .build());
    }
}
```

### Custom Exception Classes

```java
public class BusinessException extends RuntimeException {
    private final Status status;
    private final String errorCode;
    
    public BusinessException(String message, Status status, String errorCode) {
        super(message);
        this.status = status;
        this.errorCode = errorCode;
    }
}

// Specific exceptions
public class ResourceNotFoundException extends BusinessException {
    public ResourceNotFoundException(String resource, String id) {
        super(
            String.format("%s not found with id: %s", resource, id),
            Status.NOT_FOUND,
            "RESOURCE_NOT_FOUND"
        );
    }
}
```

### Error Code Conventions

| Prefix | Category | HTTP Status |
|--------|----------|-------------|
| `AUTH_` | Authentication | 401 |
| `FORBIDDEN_` | Authorization | 403 |
| `VALIDATION_` | Input validation | 400 |
| `NOT_FOUND_` | Resource not found | 404 |
| `CONFLICT_` | Conflict/duplicate | 409 |
| `RATE_LIMIT_` | Rate limiting | 429 |
| `EXTERNAL_` | External service error | 502 |
| `INTERNAL_` | Internal error | 500 |

---

## Kafka Event Pattern

### Event Publishing

```java
// Spring Cloud Stream pattern (common in BW)
@Service
@RequiredArgsConstructor
public class PaymentEventPublisher {
    
    private final StreamBridge streamBridge;
    
    public void publishPaymentCompleted(PaymentCompletedEvent event) {
        streamBridge.send("payments-out-0", event);
    }
}

// Event structure
@Data
@Builder
public class PaymentCompletedEvent {
    private String eventId;
    private String eventType;
    private Instant timestamp;
    private String userId;
    private String transactionId;
    private BigDecimal amount;
    private String status;
    private Map<String, Object> metadata;
}
```

### Event Consumption

```java
// Spring Cloud Stream consumer
@Configuration
public class KafkaConsumerConfig {
    
    @Bean
    public Consumer<PaymentCompletedEvent> paymentCompletedConsumer(
            LoyaltyService loyaltyService) {
        return event -> {
            log.info("Received payment event: {}", event.getEventId());
            loyaltyService.processPaymentForRewards(event);
        };
    }
}

// application.yml
spring:
  cloud:
    stream:
      bindings:
        paymentCompletedConsumer-in-0:
          destination: payments
          group: loyalty-service
```

### Event Naming Convention

```
{domain}.{entity}.{past_tense_verb}

Examples:
- payments.transaction.completed
- payments.disbursement.processed
- user.account.created
- lending.loan.approved
- loyalty.points.earned
```

### Kafka Topics Reference

| Topic | Publishers | Consumers |
|-------|------------|-----------|
| `transactions` | accounting-service, payments | dracula-v2, transaction-history, loyalty |
| `payments` | payments, banking | dracula-v2, risk, notification |
| `user-events` | multi-tenant-auth, accounting-service | dracula-v2, loyalty, risk |
| `loyalty-activities` | loyalty, payments | dracula-v2, notification |
| `banking-events` | banking, banking-batch | dracula-v2, transaction-history |
| `lending-events` | los-lender, fs-bnpl-service | dracula-v2, risk |

---

## Database Pattern

### Multi-Module Database Access

Most BW services use a layered/hexagonal approach:

```
┌─────────────────────────────────────────┐
│              Controller                  │
├─────────────────────────────────────────┤
│               Service                    │
├─────────────────────────────────────────┤
│             Repository                   │
│   (Spring Data JPA / R2DBC)             │
├─────────────────────────────────────────┤
│              Entity                      │
└─────────────────────────────────────────┘
```

### Entity Pattern

```java
@Entity
@Table(name = "transactions")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class Transaction {
    
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    
    @Column(name = "user_id", nullable = false)
    private String userId;
    
    @Column(name = "amount", nullable = false)
    private BigDecimal amount;
    
    @Enumerated(EnumType.STRING)
    @Column(name = "status")
    private TransactionStatus status;
    
    @Column(name = "created_at")
    private Instant createdAt;
    
    @Column(name = "updated_at")
    private Instant updatedAt;
    
    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
        updatedAt = Instant.now();
    }
    
    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }
}
```

### Repository Pattern

```java
public interface TransactionRepository extends JpaRepository<Transaction, Long> {
    
    List<Transaction> findByUserIdOrderByCreatedAtDesc(String userId);
    
    @Query("SELECT t FROM Transaction t WHERE t.userId = :userId AND t.createdAt BETWEEN :start AND :end")
    List<Transaction> findByUserIdAndDateRange(
        @Param("userId") String userId,
        @Param("start") Instant start,
        @Param("end") Instant end
    );
    
    Optional<Transaction> findByTransactionReference(String reference);
}
```

### Reactive Repository (R2DBC)

For reactive services (banking, miniatm-backend, retail-backend, transaction-history):

```java
public interface TransactionRepository extends ReactiveCrudRepository<Transaction, Long> {
    
    Flux<Transaction> findByUserIdOrderByCreatedAtDesc(String userId);
    
    Mono<Transaction> findByTransactionReference(String reference);
}
```

### Database Migration (Flyway)

```sql
-- Location: src/main/resources/db/migration/V1__create_transactions.sql
CREATE TABLE transactions (
    id BIGSERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    amount DECIMAL(19,2) NOT NULL,
    status VARCHAR(20) NOT NULL,
    transaction_reference VARCHAR(100) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_transactions_created_at ON transactions(created_at);
```

---

## Resilience Pattern

### Circuit Breaker (Resilience4j)

```java
@Service
@RequiredArgsConstructor
public class ExternalPaymentService {
    
    private final PaymentProviderClient client;
    
    @CircuitBreaker(name = "paymentProvider", fallbackMethod = "fallbackPayment")
    @Retry(name = "paymentProvider")
    public PaymentResponse processPayment(PaymentRequest request) {
        return client.process(request);
    }
    
    private PaymentResponse fallbackPayment(PaymentRequest request, Exception e) {
        log.error("Payment provider unavailable, queuing for retry", e);
        // Queue for later processing or return cached response
        return PaymentResponse.builder()
            .status(PaymentStatus.PENDING)
            .message("Payment queued for processing")
            .build();
    }
}
```

### Configuration

```yaml
# application.yml
resilience4j:
  circuitbreaker:
    instances:
      paymentProvider:
        slidingWindowSize: 10
        failureRateThreshold: 50
        waitDurationInOpenState: 10000
        permittedNumberOfCallsInHalfOpenState: 3
  retry:
    instances:
      paymentProvider:
        maxAttempts: 3
        waitDuration: 1000
        exponentialBackoffMultiplier: 2
```

---

## Caching Pattern (Redis)

### Redisson Configuration

```java
@Configuration
public class RedisConfig {
    
    @Bean
    public RedissonClient redissonClient() {
        Config config = new Config();
        config.useSingleServer()
            .setAddress("redis://" + redisHost + ":" + redisPort)
            .setPassword(redisPassword);
        return Redisson.create(config);
    }
}
```

### Cache Usage

```java
@Service
@RequiredArgsConstructor
public class UserService {
    
    private final RedissonClient redisson;
    private final UserRepository userRepository;
    
    public User getUser(String userId) {
        RBucket<User> bucket = redisson.getBucket("user:" + userId);
        User cached = bucket.get();
        
        if (cached != null) {
            return cached;
        }
        
        User user = userRepository.findById(userId)
            .orElseThrow(() -> new ResourceNotFoundException("User", userId));
        
        bucket.set(user, 5, TimeUnit.MINUTES);
        return user;
    }
    
    public void invalidateUserCache(String userId) {
        redisson.getBucket("user:" + userId).delete();
    }
}
```

---

## External Service Integration Pattern

### Feign Client Pattern

```java
@FeignClient(
    name = "notification-service",
    url = "${NOTIFICATION_SERVICE_URL}",
    configuration = FeignConfig.class
)
public interface NotificationClient {
    
    @PostMapping("/notification/api/sms/send")
    NotificationResponse sendSms(@RequestBody SmsRequest request);
    
    @PostMapping("/notification/api/push/send")
    NotificationResponse sendPush(@RequestBody PushRequest request);
}

@Configuration
public class FeignConfig {
    
    @Bean
    public RequestInterceptor requestInterceptor() {
        return template -> {
            template.header("Content-Type", "application/json");
            template.header("X-Service-Name", "payments-service");
        };
    }
}
```

### Reactive Feign (for WebFlux services)

```java
@ReactiveFeignClient(
    name = "payments-service",
    url = "${PAYMENT_SERVICE_URL}"
)
public interface PaymentsClient {
    
    @PostMapping("/payments/api/disburse")
    Mono<DisbursementResponse> disburse(@RequestBody DisbursementRequest request);
}
```

---

## Logging Pattern

### Structured Logging with BW Common Logger

```java
import com.bukuwarung.logger.BWLogger;

@Service
@Slf4j
public class PaymentService {
    
    public void processPayment(PaymentRequest request) {
        BWLogger.info(log, "Processing payment", Map.of(
            "userId", request.getUserId(),
            "amount", request.getAmount(),
            "transactionId", request.getTransactionId()
        ));
        
        try {
            // Process payment
            BWLogger.info(log, "Payment completed successfully", Map.of(
                "transactionId", request.getTransactionId(),
                "status", "SUCCESS"
            ));
        } catch (Exception e) {
            BWLogger.error(log, "Payment failed", Map.of(
                "transactionId", request.getTransactionId(),
                "error", e.getMessage()
            ), e);
            throw e;
        }
    }
}
```

### Request/Response Logging (Zalando Logbook)

```yaml
# application.yml
logbook:
  include:
    - /api/**
  exclude:
    - /actuator/**
  format:
    style: json
  obfuscate:
    headers:
      - Authorization
    parameters:
      - password
      - pin
```

---

## Testing Pattern

### Unit Test Structure

```java
@ExtendWith(MockitoExtension.class)
class PaymentServiceTest {
    
    @Mock
    private PaymentRepository paymentRepository;
    
    @Mock
    private NotificationClient notificationClient;
    
    @InjectMocks
    private PaymentService paymentService;
    
    @Test
    void shouldProcessPaymentSuccessfully() {
        // Given
        PaymentRequest request = PaymentRequest.builder()
            .userId("user-123")
            .amount(new BigDecimal("100000"))
            .build();
        
        when(paymentRepository.save(any())).thenReturn(mockPayment());
        
        // When
        PaymentResponse response = paymentService.process(request);
        
        // Then
        assertThat(response.getStatus()).isEqualTo(PaymentStatus.SUCCESS);
        verify(notificationClient).sendPush(any());
    }
}
```

### Integration Test with Testcontainers

```java
@SpringBootTest
@Testcontainers
class PaymentIntegrationTest {
    
    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:12");
    
    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
    }
    
    @Autowired
    private PaymentService paymentService;
    
    @Test
    void shouldPersistPayment() {
        // Test implementation
    }
}
```
