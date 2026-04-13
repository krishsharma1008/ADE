# Banking Batch

## Description

Banking Batch is a microservice that handles batch processing operations for the banking domain. It processes bulk banking transactions, scheduled jobs, and asynchronous banking operations that don't require real-time processing. This service works alongside the main Banking service to handle high-volume, batch-oriented workloads.

## GitHub Repository

[https://github.com/bukuwarung/banking-batch](https://github.com/bukuwarung/banking-batch)

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 17 |
| Framework | Spring Boot 2.7.0 (WebFlux - Reactive) |
| Build Tool | Gradle |
| Database | PostgreSQL (R2DBC - Reactive) |
| Migration | Liquibase |
| Messaging | Spring Cloud Stream with Kafka |
| Documentation | SpringDoc OpenAPI WebFlux |

## Key Features / Responsibilities

- **Batch Transaction Processing**: Process bulk banking transactions
- **Scheduled Jobs**: Execute time-based banking operations
- **Event Processing**: Handle banking events from Kafka streams
- **Reconciliation**: Perform batch reconciliation operations
- **Report Generation**: Generate batch reports and summaries
- **Reactive Architecture**: Non-blocking operations using WebFlux
- **Circuit Breaker**: Resilience4j for fault tolerance

## API Routes (via App Gateway)

| Route Pattern | Description |
|---------------|-------------|
| `/banking/batch/**` | All banking batch operation endpoints |

## Project Structure

```
banking-batch/
├── src/main/java/com/bukuwarung/banking/batch/
│   ├── config/        # Configuration classes
│   ├── controller/    # REST API controllers
│   ├── domain/        # Domain entities
│   ├── dto/           # Data transfer objects
│   ├── mapper/        # MapStruct mappers
│   ├── repository/    # R2DBC repositories
│   ├── service/       # Business logic layer
│   └── client/        # External service clients
└── deployments/       # Deployment configurations
```

## Dependencies / Integrations

### External Services
- **Kafka**: Event streaming for transaction processing

### Internal Services
- **App Gateway**: Routes traffic through `/banking/batch/**`
- **Banking Service**: Core banking operations
- **Spring Cloud Config**: Centralized configuration
- **Spring Cloud Bus**: Configuration updates via Kafka

### Key Libraries
- Spring WebFlux for reactive REST APIs
- Spring Data R2DBC for reactive database access
- Spring Cloud Stream for Kafka integration
- Spring Cloud OpenFeign for service-to-service communication
- Reactive Feign for non-blocking HTTP clients
- Liquibase for database migrations
- MapStruct for object mapping
- Zalando Problem for error handling
- BW Common Logger for structured logging
- OpenTracing for distributed tracing

## Development

### Requirements
- Git
- Java 17
- Gradle
- PostgreSQL
- Kafka

### Build
```bash
./gradlew build
```

### Run Tests
```bash
./gradlew test
```

### Run Integration Tests
```bash
./gradlew integrationTest
```

### Running with Testcontainers
```bash
./gradlew integrationTest -Ptestcontainers
```

### Code Style
Spotless gradle plugin is enabled. Run before committing:
```bash
./gradlew spotlessApply
```

## Architecture

The service follows a batch processing architecture:

1. **Event Consumption**: Batch jobs are triggered by Kafka events or schedules
2. **Processing**: Transactions are processed in batches for efficiency
3. **Storage**: Results stored in PostgreSQL using R2DBC
4. **Notification**: Other services notified via Kafka upon completion

## Relationship with Banking Service

- **Banking Service**: Handles real-time, synchronous banking operations
- **Banking Batch**: Handles asynchronous, bulk, and scheduled operations

This separation allows:
- Better scalability for high-volume operations
- Isolated failure domains
- Optimized resource usage for different workload types
