# Code Examples

Copy-paste code templates for common tasks across BukuWarung services.

---

## Table of Contents

1. [REST Controller](#rest-controller)
2. [Service Layer](#service-layer)
3. [Repository Layer](#repository-layer)
4. [Feign Client](#feign-client)
5. [Kafka Producer](#kafka-producer)
6. [Kafka Consumer](#kafka-consumer)
7. [Exception Handling](#exception-handling)
8. [Entity with Audit](#entity-with-audit)
9. [DTO with Validation](#dto-with-validation)
10. [Reactive Controller (WebFlux)](#reactive-controller-webflux)
11. [Reactive Repository (R2DBC)](#reactive-repository-r2dbc)
12. [Circuit Breaker](#circuit-breaker)
13. [Redis Caching](#redis-caching)
14. [Flyway Migration](#flyway-migration)
15. [Unit Test](#unit-test)
16. [Integration Test](#integration-test)

---

## REST Controller

### Standard MVC Controller

```java
package com.bukuwarung.servicename.controller;

import com.bukuwarung.servicename.dto.CreateResourceRequest;
import com.bukuwarung.servicename.dto.ResourceResponse;
import com.bukuwarung.servicename.service.ResourceService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import io.swagger.v3.oas.annotations.tags.Tag;
import javax.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/resources")
@RequiredArgsConstructor
@Slf4j
@Tag(name = "Resources", description = "Resource management APIs")
public class ResourceController {

    private final ResourceService resourceService;

    @PostMapping
    @Operation(summary = "Create a new resource")
    @ApiResponses({
        @ApiResponse(responseCode = "201", description = "Resource created"),
        @ApiResponse(responseCode = "400", description = "Invalid request"),
        @ApiResponse(responseCode = "500", description = "Internal error")
    })
    public ResponseEntity<ResourceResponse> create(
            @Valid @RequestBody CreateResourceRequest request,
            @RequestHeader("X-User-Id") String userId) {
        
        log.info("Creating resource for user: {}", userId);
        ResourceResponse response = resourceService.create(request, userId);
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }

    @GetMapping("/{id}")
    @Operation(summary = "Get resource by ID")
    public ResponseEntity<ResourceResponse> getById(
            @Parameter(description = "Resource ID") @PathVariable String id) {
        
        return resourceService.findById(id)
            .map(ResponseEntity::ok)
            .orElse(ResponseEntity.notFound().build());
    }

    @GetMapping
    @Operation(summary = "List resources with pagination")
    public ResponseEntity<Page<ResourceResponse>> list(
            @RequestParam(required = false) String status,
            Pageable pageable) {
        
        Page<ResourceResponse> resources = resourceService.findAll(status, pageable);
        return ResponseEntity.ok(resources);
    }

    @PutMapping("/{id}")
    @Operation(summary = "Update resource")
    public ResponseEntity<ResourceResponse> update(
            @PathVariable String id,
            @Valid @RequestBody CreateResourceRequest request) {
        
        ResourceResponse response = resourceService.update(id, request);
        return ResponseEntity.ok(response);
    }

    @DeleteMapping("/{id}")
    @Operation(summary = "Delete resource")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        resourceService.delete(id);
        return ResponseEntity.noContent().build();
    }
}
```

---

## Service Layer

### Standard Service Implementation

```java
package com.bukuwarung.servicename.service;

import com.bukuwarung.logger.BWLogger;
import com.bukuwarung.servicename.dto.CreateResourceRequest;
import com.bukuwarung.servicename.dto.ResourceResponse;
import com.bukuwarung.servicename.entity.Resource;
import com.bukuwarung.servicename.exception.ResourceNotFoundException;
import com.bukuwarung.servicename.mapper.ResourceMapper;
import com.bukuwarung.servicename.repository.ResourceRepository;
import java.util.Map;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
@Slf4j
public class ResourceServiceImpl implements ResourceService {

    private final ResourceRepository resourceRepository;
    private final ResourceMapper resourceMapper;
    private final NotificationClient notificationClient;

    @Override
    @Transactional
    public ResourceResponse create(CreateResourceRequest request, String userId) {
        BWLogger.info(log, "Creating resource", Map.of(
            "userId", userId,
            "type", request.getType()
        ));

        Resource entity = resourceMapper.toEntity(request);
        entity.setUserId(userId);
        entity.setStatus(ResourceStatus.ACTIVE);

        Resource saved = resourceRepository.save(entity);

        BWLogger.info(log, "Resource created", Map.of(
            "resourceId", saved.getId(),
            "userId", userId
        ));

        return resourceMapper.toResponse(saved);
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<ResourceResponse> findById(String id) {
        return resourceRepository.findById(id)
            .map(resourceMapper::toResponse);
    }

    @Override
    @Transactional(readOnly = true)
    public Page<ResourceResponse> findAll(String status, Pageable pageable) {
        Page<Resource> resources;
        
        if (status != null) {
            resources = resourceRepository.findByStatus(ResourceStatus.valueOf(status), pageable);
        } else {
            resources = resourceRepository.findAll(pageable);
        }
        
        return resources.map(resourceMapper::toResponse);
    }

    @Override
    @Transactional
    public ResourceResponse update(String id, CreateResourceRequest request) {
        Resource existing = resourceRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("Resource", id));

        resourceMapper.updateEntity(existing, request);
        Resource saved = resourceRepository.save(existing);
        
        return resourceMapper.toResponse(saved);
    }

    @Override
    @Transactional
    public void delete(String id) {
        if (!resourceRepository.existsById(id)) {
            throw new ResourceNotFoundException("Resource", id);
        }
        resourceRepository.deleteById(id);
    }
}
```

---

## Repository Layer

### JPA Repository

```java
package com.bukuwarung.servicename.repository;

import com.bukuwarung.servicename.entity.Resource;
import com.bukuwarung.servicename.enums.ResourceStatus;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

@Repository
public interface ResourceRepository extends JpaRepository<Resource, String> {

    Optional<Resource> findByIdAndUserId(String id, String userId);

    List<Resource> findByUserIdOrderByCreatedAtDesc(String userId);

    Page<Resource> findByStatus(ResourceStatus status, Pageable pageable);

    Page<Resource> findByUserIdAndStatus(String userId, ResourceStatus status, Pageable pageable);

    @Query("SELECT r FROM Resource r WHERE r.userId = :userId " +
           "AND r.createdAt BETWEEN :start AND :end " +
           "ORDER BY r.createdAt DESC")
    List<Resource> findByUserIdAndDateRange(
        @Param("userId") String userId,
        @Param("start") Instant start,
        @Param("end") Instant end
    );

    @Query("SELECT COUNT(r) FROM Resource r WHERE r.userId = :userId AND r.status = :status")
    long countByUserIdAndStatus(
        @Param("userId") String userId,
        @Param("status") ResourceStatus status
    );

    boolean existsByReferenceId(String referenceId);
}
```

---

## Feign Client

### Service-to-Service Client

```java
package com.bukuwarung.servicename.client;

import com.bukuwarung.servicename.client.dto.NotificationRequest;
import com.bukuwarung.servicename.client.dto.NotificationResponse;
import com.bukuwarung.servicename.client.dto.UserResponse;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.*;

@FeignClient(
    name = "notification-service",
    url = "${NOTIFICATION_SERVICE_URL}",
    configuration = FeignClientConfig.class
)
public interface NotificationClient {

    @PostMapping("/notification/api/sms/send")
    NotificationResponse sendSms(@RequestBody NotificationRequest request);

    @PostMapping("/notification/api/push/send")
    NotificationResponse sendPush(@RequestBody NotificationRequest request);

    @PostMapping("/notification/api/whatsapp/send")
    NotificationResponse sendWhatsApp(@RequestBody NotificationRequest request);
}

@FeignClient(
    name = "auth-service",
    url = "${MULTI_TENANT_AUTH_SERVICE_URL}",
    configuration = FeignClientConfig.class
)
public interface AuthClient {

    @GetMapping("/api/v3/auth/users/{userId}")
    UserResponse getUser(@PathVariable String userId);

    @GetMapping("/api/v3/auth/validate")
    TokenValidationResponse validateToken(
        @RequestHeader("Authorization") String token
    );
}
```

### Feign Configuration

```java
package com.bukuwarung.servicename.config;

import feign.RequestInterceptor;
import feign.codec.ErrorDecoder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class FeignClientConfig {

    @Bean
    public RequestInterceptor requestInterceptor() {
        return template -> {
            template.header("Content-Type", "application/json");
            template.header("X-Service-Name", "my-service");
        };
    }

    @Bean
    public ErrorDecoder errorDecoder() {
        return new CustomFeignErrorDecoder();
    }
}
```

---

## Kafka Producer

### Spring Cloud Stream Producer

```java
package com.bukuwarung.servicename.publisher;

import com.bukuwarung.logger.BWLogger;
import com.bukuwarung.servicename.event.ResourceCreatedEvent;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.cloud.stream.function.StreamBridge;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
@Slf4j
public class ResourceEventPublisher {

    private final StreamBridge streamBridge;

    public void publishResourceCreated(String resourceId, String userId, String type) {
        ResourceCreatedEvent event = ResourceCreatedEvent.builder()
            .eventId(UUID.randomUUID().toString())
            .eventType("resource.created")
            .timestamp(Instant.now())
            .resourceId(resourceId)
            .userId(userId)
            .type(type)
            .build();

        boolean sent = streamBridge.send("resources-out-0", event);

        BWLogger.info(log, "Published resource created event", Map.of(
            "eventId", event.getEventId(),
            "resourceId", resourceId,
            "sent", sent
        ));
    }
}
```

### Event DTO

```java
package com.bukuwarung.servicename.event;

import java.time.Instant;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ResourceCreatedEvent {
    private String eventId;
    private String eventType;
    private Instant timestamp;
    private String resourceId;
    private String userId;
    private String type;
}
```

### Kafka Configuration (application.yml)

```yaml
spring:
  cloud:
    stream:
      kafka:
        binder:
          brokers: ${KAFKA_BROKERS}
          auto-create-topics: false
      bindings:
        resources-out-0:
          destination: resources
          content-type: application/json
```

---

## Kafka Consumer

### Spring Cloud Stream Consumer

```java
package com.bukuwarung.servicename.consumer;

import com.bukuwarung.logger.BWLogger;
import com.bukuwarung.servicename.event.PaymentCompletedEvent;
import com.bukuwarung.servicename.service.LoyaltyService;
import java.util.Map;
import java.util.function.Consumer;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
@RequiredArgsConstructor
@Slf4j
public class KafkaConsumerConfig {

    private final LoyaltyService loyaltyService;

    @Bean
    public Consumer<PaymentCompletedEvent> paymentCompletedConsumer() {
        return event -> {
            BWLogger.info(log, "Received payment completed event", Map.of(
                "eventId", event.getEventId(),
                "transactionId", event.getTransactionId(),
                "userId", event.getUserId()
            ));

            try {
                loyaltyService.processPaymentForRewards(event);
                
                BWLogger.info(log, "Processed payment event successfully", Map.of(
                    "eventId", event.getEventId()
                ));
            } catch (Exception e) {
                BWLogger.error(log, "Failed to process payment event", Map.of(
                    "eventId", event.getEventId(),
                    "error", e.getMessage()
                ), e);
                throw e; // Rethrow to trigger retry/DLQ
            }
        };
    }
}
```

### Consumer Configuration (application.yml)

```yaml
spring:
  cloud:
    stream:
      bindings:
        paymentCompletedConsumer-in-0:
          destination: payments
          group: loyalty-service
          consumer:
            max-attempts: 3
            back-off-initial-interval: 1000
            back-off-multiplier: 2.0
```

---

## Exception Handling

### Global Exception Handler

```java
package com.bukuwarung.servicename.exception;

import com.bukuwarung.logger.BWLogger;
import java.time.Instant;
import java.util.Map;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.zalando.problem.Problem;
import org.zalando.problem.Status;
import org.zalando.problem.spring.web.advice.ProblemHandling;

@RestControllerAdvice
@Slf4j
public class GlobalExceptionHandler implements ProblemHandling {

    @ExceptionHandler(ResourceNotFoundException.class)
    public ResponseEntity<Problem> handleNotFound(ResourceNotFoundException ex) {
        BWLogger.warn(log, "Resource not found", Map.of(
            "resource", ex.getResourceType(),
            "id", ex.getResourceId()
        ));

        Problem problem = Problem.builder()
            .withStatus(Status.NOT_FOUND)
            .withTitle("Resource Not Found")
            .withDetail(ex.getMessage())
            .with("code", "RESOURCE_NOT_FOUND")
            .with("timestamp", Instant.now())
            .build();

        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(problem);
    }

    @ExceptionHandler(BusinessException.class)
    public ResponseEntity<Problem> handleBusinessException(BusinessException ex) {
        BWLogger.warn(log, "Business exception", Map.of(
            "code", ex.getErrorCode(),
            "message", ex.getMessage()
        ));

        Problem problem = Problem.builder()
            .withStatus(Status.BAD_REQUEST)
            .withTitle("Business Error")
            .withDetail(ex.getMessage())
            .with("code", ex.getErrorCode())
            .with("timestamp", Instant.now())
            .build();

        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(problem);
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<Problem> handleValidation(MethodArgumentNotValidException ex) {
        Map<String, String> errors = ex.getBindingResult()
            .getFieldErrors()
            .stream()
            .collect(Collectors.toMap(
                FieldError::getField,
                FieldError::getDefaultMessage,
                (a, b) -> a
            ));

        Problem problem = Problem.builder()
            .withStatus(Status.BAD_REQUEST)
            .withTitle("Validation Error")
            .withDetail("Request validation failed")
            .with("code", "VALIDATION_ERROR")
            .with("errors", errors)
            .with("timestamp", Instant.now())
            .build();

        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(problem);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Problem> handleGenericException(Exception ex) {
        BWLogger.error(log, "Unexpected error", Map.of(
            "error", ex.getMessage()
        ), ex);

        Problem problem = Problem.builder()
            .withStatus(Status.INTERNAL_SERVER_ERROR)
            .withTitle("Internal Server Error")
            .withDetail("An unexpected error occurred")
            .with("code", "INTERNAL_ERROR")
            .with("timestamp", Instant.now())
            .build();

        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(problem);
    }
}
```

### Custom Exceptions

```java
package com.bukuwarung.servicename.exception;

import lombok.Getter;

@Getter
public class ResourceNotFoundException extends RuntimeException {
    private final String resourceType;
    private final String resourceId;

    public ResourceNotFoundException(String resourceType, String resourceId) {
        super(String.format("%s not found with id: %s", resourceType, resourceId));
        this.resourceType = resourceType;
        this.resourceId = resourceId;
    }
}

@Getter
public class BusinessException extends RuntimeException {
    private final String errorCode;

    public BusinessException(String message, String errorCode) {
        super(message);
        this.errorCode = errorCode;
    }
}
```

---

## Entity with Audit

### JPA Entity

```java
package com.bukuwarung.servicename.entity;

import java.math.BigDecimal;
import java.time.Instant;
import javax.persistence.*;
import lombok.*;
import org.hibernate.annotations.GenericGenerator;

@Entity
@Table(name = "resources")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class Resource {

    @Id
    @GeneratedValue(generator = "uuid2")
    @GenericGenerator(name = "uuid2", strategy = "uuid2")
    @Column(name = "id", length = 36)
    private String id;

    @Column(name = "user_id", nullable = false, length = 36)
    private String userId;

    @Column(name = "reference_id", unique = true, length = 100)
    private String referenceId;

    @Column(name = "type", nullable = false, length = 50)
    private String type;

    @Column(name = "amount", precision = 19, scale = 2)
    private BigDecimal amount;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 20)
    private ResourceStatus status;

    @Column(name = "description", length = 500)
    private String description;

    @Column(name = "metadata", columnDefinition = "jsonb")
    @Convert(converter = JsonMapConverter.class)
    private Map<String, Object> metadata;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
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

---

## DTO with Validation

### Request DTO

```java
package com.bukuwarung.servicename.dto;

import java.math.BigDecimal;
import javax.validation.constraints.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CreateResourceRequest {

    @NotBlank(message = "Type is required")
    @Size(max = 50, message = "Type must not exceed 50 characters")
    private String type;

    @NotNull(message = "Amount is required")
    @Positive(message = "Amount must be positive")
    @Digits(integer = 15, fraction = 2, message = "Invalid amount format")
    private BigDecimal amount;

    @Size(max = 500, message = "Description must not exceed 500 characters")
    private String description;

    @Pattern(regexp = "^[A-Za-z0-9-_]+$", message = "Invalid reference ID format")
    private String referenceId;
}
```

### Response DTO

```java
package com.bukuwarung.servicename.dto;

import java.math.BigDecimal;
import java.time.Instant;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ResourceResponse {
    private String id;
    private String userId;
    private String type;
    private BigDecimal amount;
    private String status;
    private String description;
    private String referenceId;
    private Instant createdAt;
    private Instant updatedAt;
}
```

---

## Reactive Controller (WebFlux)

For services using WebFlux (banking, miniatm-backend, retail-backend, transaction-history):

```java
package com.bukuwarung.servicename.controller;

import com.bukuwarung.servicename.dto.ResourceRequest;
import com.bukuwarung.servicename.dto.ResourceResponse;
import com.bukuwarung.servicename.service.ResourceService;
import javax.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@RestController
@RequestMapping("/api/v1/resources")
@RequiredArgsConstructor
@Slf4j
public class ResourceController {

    private final ResourceService resourceService;

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Mono<ResourceResponse> create(
            @Valid @RequestBody ResourceRequest request,
            @RequestHeader("X-User-Id") String userId) {
        
        return resourceService.create(request, userId)
            .doOnSuccess(r -> log.info("Resource created: {}", r.getId()))
            .doOnError(e -> log.error("Failed to create resource", e));
    }

    @GetMapping("/{id}")
    public Mono<ResourceResponse> getById(@PathVariable String id) {
        return resourceService.findById(id);
    }

    @GetMapping
    public Flux<ResourceResponse> list(
            @RequestParam(required = false) String status,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size) {
        
        return resourceService.findAll(status, page, size);
    }

    @PutMapping("/{id}")
    public Mono<ResourceResponse> update(
            @PathVariable String id,
            @Valid @RequestBody ResourceRequest request) {
        
        return resourceService.update(id, request);
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public Mono<Void> delete(@PathVariable String id) {
        return resourceService.delete(id);
    }
}
```

---

## Reactive Repository (R2DBC)

```java
package com.bukuwarung.servicename.repository;

import com.bukuwarung.servicename.entity.Resource;
import org.springframework.data.r2dbc.repository.Query;
import org.springframework.data.r2dbc.repository.R2dbcRepository;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Repository
public interface ResourceRepository extends R2dbcRepository<Resource, String> {

    Flux<Resource> findByUserIdOrderByCreatedAtDesc(String userId);

    Mono<Resource> findByIdAndUserId(String id, String userId);

    Flux<Resource> findByStatus(String status);

    @Query("SELECT * FROM resources WHERE user_id = :userId AND status = :status " +
           "ORDER BY created_at DESC LIMIT :limit OFFSET :offset")
    Flux<Resource> findByUserIdAndStatus(String userId, String status, int limit, int offset);

    Mono<Long> countByUserIdAndStatus(String userId, String status);

    Mono<Boolean> existsByReferenceId(String referenceId);
}
```

---

## Circuit Breaker

### Resilience4j Configuration

```java
package com.bukuwarung.servicename.service;

import com.bukuwarung.servicename.client.PaymentProviderClient;
import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.github.resilience4j.retry.annotation.Retry;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
@Slf4j
public class ExternalPaymentService {

    private final PaymentProviderClient client;

    @CircuitBreaker(name = "paymentProvider", fallbackMethod = "fallbackProcess")
    @Retry(name = "paymentProvider")
    public PaymentResponse processPayment(PaymentRequest request) {
        return client.process(request);
    }

    private PaymentResponse fallbackProcess(PaymentRequest request, Exception e) {
        log.error("Payment provider unavailable, using fallback", e);
        
        return PaymentResponse.builder()
            .status(PaymentStatus.PENDING)
            .message("Payment queued for retry")
            .build();
    }
}
```

### application.yml Configuration

```yaml
resilience4j:
  circuitbreaker:
    instances:
      paymentProvider:
        sliding-window-size: 10
        failure-rate-threshold: 50
        wait-duration-in-open-state: 10s
        permitted-number-of-calls-in-half-open-state: 3
        record-exceptions:
          - java.io.IOException
          - java.net.SocketTimeoutException
          - feign.FeignException
  retry:
    instances:
      paymentProvider:
        max-attempts: 3
        wait-duration: 1s
        exponential-backoff-multiplier: 2
        retry-exceptions:
          - java.io.IOException
          - java.net.SocketTimeoutException
```

---

## Redis Caching

### Redisson Configuration

```java
package com.bukuwarung.servicename.config;

import org.redisson.Redisson;
import org.redisson.api.RedissonClient;
import org.redisson.config.Config;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class RedisConfig {

    @Value("${REDIS_HOST:localhost}")
    private String redisHost;

    @Value("${REDIS_PORT:6379}")
    private int redisPort;

    @Value("${REDIS_PASSWORD:}")
    private String redisPassword;

    @Bean
    public RedissonClient redissonClient() {
        Config config = new Config();
        config.useSingleServer()
            .setAddress("redis://" + redisHost + ":" + redisPort)
            .setPassword(redisPassword.isEmpty() ? null : redisPassword)
            .setConnectionMinimumIdleSize(5)
            .setConnectionPoolSize(10);
        return Redisson.create(config);
    }
}
```

### Cache Service

```java
package com.bukuwarung.servicename.service;

import java.util.concurrent.TimeUnit;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.redisson.api.RBucket;
import org.redisson.api.RedissonClient;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
@Slf4j
public class CacheService {

    private final RedissonClient redisson;

    public <T> T get(String key, Class<T> type) {
        RBucket<T> bucket = redisson.getBucket(key);
        return bucket.get();
    }

    public <T> void set(String key, T value, long ttlMinutes) {
        RBucket<T> bucket = redisson.getBucket(key);
        bucket.set(value, ttlMinutes, TimeUnit.MINUTES);
    }

    public void delete(String key) {
        redisson.getBucket(key).delete();
    }

    public boolean exists(String key) {
        return redisson.getBucket(key).isExists();
    }
}
```

---

## Flyway Migration

### Migration Script

Location: `src/main/resources/db/migration/V1__create_resources_table.sql`

```sql
-- V1__create_resources_table.sql
CREATE TABLE resources (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    reference_id VARCHAR(100) UNIQUE,
    type VARCHAR(50) NOT NULL,
    amount DECIMAL(19, 2),
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    description VARCHAR(500),
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_resources_user_id ON resources(user_id);
CREATE INDEX idx_resources_status ON resources(status);
CREATE INDEX idx_resources_user_status ON resources(user_id, status);
CREATE INDEX idx_resources_created_at ON resources(created_at);
CREATE INDEX idx_resources_reference_id ON resources(reference_id) WHERE reference_id IS NOT NULL;

-- Comments
COMMENT ON TABLE resources IS 'Stores resource records';
COMMENT ON COLUMN resources.user_id IS 'ID of the user who owns this resource';
COMMENT ON COLUMN resources.metadata IS 'Additional JSON metadata';
```

### Naming Convention

```
V{YYYYMMDD}{sequence}__{description}.sql

Examples:
V20240120001__create_resources_table.sql
V20240120002__add_category_column.sql
V20240121001__create_transactions_table.sql
```

---

## Unit Test

### Service Unit Test

```java
package com.bukuwarung.servicename.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import com.bukuwarung.servicename.dto.CreateResourceRequest;
import com.bukuwarung.servicename.dto.ResourceResponse;
import com.bukuwarung.servicename.entity.Resource;
import com.bukuwarung.servicename.exception.ResourceNotFoundException;
import com.bukuwarung.servicename.mapper.ResourceMapper;
import com.bukuwarung.servicename.repository.ResourceRepository;
import java.math.BigDecimal;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class ResourceServiceImplTest {

    @Mock
    private ResourceRepository resourceRepository;

    @Mock
    private ResourceMapper resourceMapper;

    @InjectMocks
    private ResourceServiceImpl resourceService;

    private CreateResourceRequest request;
    private Resource entity;
    private ResourceResponse response;

    @BeforeEach
    void setUp() {
        request = CreateResourceRequest.builder()
            .type("PAYMENT")
            .amount(new BigDecimal("100000"))
            .description("Test payment")
            .build();

        entity = Resource.builder()
            .id("res-123")
            .userId("user-456")
            .type("PAYMENT")
            .amount(new BigDecimal("100000"))
            .status(ResourceStatus.ACTIVE)
            .build();

        response = ResourceResponse.builder()
            .id("res-123")
            .userId("user-456")
            .type("PAYMENT")
            .amount(new BigDecimal("100000"))
            .status("ACTIVE")
            .build();
    }

    @Test
    void shouldCreateResourceSuccessfully() {
        // Given
        when(resourceMapper.toEntity(request)).thenReturn(entity);
        when(resourceRepository.save(any(Resource.class))).thenReturn(entity);
        when(resourceMapper.toResponse(entity)).thenReturn(response);

        // When
        ResourceResponse result = resourceService.create(request, "user-456");

        // Then
        assertThat(result).isNotNull();
        assertThat(result.getId()).isEqualTo("res-123");
        assertThat(result.getType()).isEqualTo("PAYMENT");
        verify(resourceRepository).save(any(Resource.class));
    }

    @Test
    void shouldReturnResourceWhenFound() {
        // Given
        when(resourceRepository.findById("res-123")).thenReturn(Optional.of(entity));
        when(resourceMapper.toResponse(entity)).thenReturn(response);

        // When
        Optional<ResourceResponse> result = resourceService.findById("res-123");

        // Then
        assertThat(result).isPresent();
        assertThat(result.get().getId()).isEqualTo("res-123");
    }

    @Test
    void shouldReturnEmptyWhenNotFound() {
        // Given
        when(resourceRepository.findById("res-999")).thenReturn(Optional.empty());

        // When
        Optional<ResourceResponse> result = resourceService.findById("res-999");

        // Then
        assertThat(result).isEmpty();
    }

    @Test
    void shouldThrowExceptionWhenUpdatingNonExistentResource() {
        // Given
        when(resourceRepository.findById("res-999")).thenReturn(Optional.empty());

        // When/Then
        assertThatThrownBy(() -> resourceService.update("res-999", request))
            .isInstanceOf(ResourceNotFoundException.class)
            .hasMessageContaining("res-999");
    }
}
```

---

## Integration Test

### Repository Integration Test with Testcontainers

```java
package com.bukuwarung.servicename.repository;

import static org.assertj.core.api.Assertions.assertThat;

import com.bukuwarung.servicename.entity.Resource;
import com.bukuwarung.servicename.enums.ResourceStatus;
import java.math.BigDecimal;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@DataJpaTest
@Testcontainers
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
class ResourceRepositoryIntegrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:12")
        .withDatabaseName("testdb")
        .withUsername("test")
        .withPassword("test");

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
    }

    @Autowired
    private ResourceRepository resourceRepository;

    @BeforeEach
    void setUp() {
        resourceRepository.deleteAll();
    }

    @Test
    void shouldSaveAndFindResource() {
        // Given
        Resource resource = Resource.builder()
            .userId("user-123")
            .type("PAYMENT")
            .amount(new BigDecimal("50000"))
            .status(ResourceStatus.ACTIVE)
            .build();

        // When
        Resource saved = resourceRepository.save(resource);

        // Then
        assertThat(saved.getId()).isNotNull();
        assertThat(resourceRepository.findById(saved.getId())).isPresent();
    }

    @Test
    void shouldFindByUserIdAndStatus() {
        // Given
        resourceRepository.save(createResource("user-1", ResourceStatus.ACTIVE));
        resourceRepository.save(createResource("user-1", ResourceStatus.ACTIVE));
        resourceRepository.save(createResource("user-1", ResourceStatus.INACTIVE));
        resourceRepository.save(createResource("user-2", ResourceStatus.ACTIVE));

        // When
        List<Resource> results = resourceRepository.findByUserIdAndStatus(
            "user-1", ResourceStatus.ACTIVE, Pageable.ofSize(10)
        ).getContent();

        // Then
        assertThat(results).hasSize(2);
        assertThat(results).allMatch(r -> r.getUserId().equals("user-1"));
        assertThat(results).allMatch(r -> r.getStatus() == ResourceStatus.ACTIVE);
    }

    private Resource createResource(String userId, ResourceStatus status) {
        return Resource.builder()
            .userId(userId)
            .type("PAYMENT")
            .amount(new BigDecimal("10000"))
            .status(status)
            .build();
    }
}
```

---

## Quick Reference

| Template | Use Case |
|----------|----------|
| REST Controller | Standard CRUD API endpoints |
| Service Layer | Business logic implementation |
| Repository | Data access with custom queries |
| Feign Client | Service-to-service HTTP calls |
| Kafka Producer | Publishing events to Kafka |
| Kafka Consumer | Consuming events from Kafka |
| Exception Handling | Global error handling with Zalando Problem |
| Entity | JPA entity with audit fields |
| DTO | Request/response with validation |
| Reactive Controller | WebFlux endpoints for reactive services |
| Reactive Repository | R2DBC repository for reactive services |
| Circuit Breaker | Resilience4j fault tolerance |
| Redis Caching | Redisson-based caching |
| Flyway Migration | Database schema migrations |
| Unit Test | Mockito-based unit testing |
| Integration Test | Testcontainers-based integration testing |
