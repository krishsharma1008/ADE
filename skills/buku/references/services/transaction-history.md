# Transaction History

## Description

Transaction History is a reactive microservice that provides a centralized view of all user transactions across BukuWarung's platform. It aggregates transaction data from various sources and provides APIs for users to view their transaction history, search transactions, and access transaction details.

## GitHub Repository

[https://github.com/bukuwarung/transaction-history](https://github.com/bukuwarung/transaction-history)

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 17 |
| Framework | Spring Boot 2.7.0 (WebFlux - Reactive) |
| Build Tool | Gradle |
| Database | PostgreSQL (R2DBC - Reactive) |
| Migration | Flyway |
| Messaging | Spring Cloud Stream with Kafka |
| Documentation | SpringDoc OpenAPI WebFlux |

## Key Features / Responsibilities

- **Transaction Aggregation**: Collect and store transactions from multiple sources
- **Reactive Architecture**: Built with Spring WebFlux and R2DBC for non-blocking operations
- **Event-Driven**: Kafka integration for real-time transaction ingestion
- **Transaction Search**: Query and filter transaction history
- **Transaction Details**: Retrieve detailed information for individual transactions
- **Authentication**: Firebase authentication integration
- **Circuit Breaker**: Resilience4j for fault tolerance

## API Routes (via App Gateway)

| Route Pattern | Description |
|---------------|-------------|
| `/transaction-history/**` | All transaction history operations |

## Project Structure

```
transaction-history/
├── src/main/java/com/bukuwarung/transaction/history/
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
- **Firebase**: User authentication
- **Kafka**: Event streaming for transaction ingestion

### Internal Services
- **App Gateway**: Routes traffic through `/transaction-history/**`
- **Spring Cloud Config**: Centralized configuration
- **Various Transaction Sources**: Payments, Banking, etc.

### Key Libraries
- Spring WebFlux for reactive REST APIs
- Spring Data R2DBC for reactive database access
- Spring Cloud Stream for Kafka integration
- Spring Cloud OpenFeign for service-to-service communication
- Reactive Feign for non-blocking HTTP clients
- MapStruct for object mapping
- Jackson for JSON processing
- BW Common Logger for structured logging

## Development

### Requirements
- Git
- Java 17
- Gradle
- PostgreSQL
- Kafka (optional for local development)

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

## Architecture

The service follows a reactive architecture pattern:

1. **Event Ingestion**: Transactions are consumed from Kafka topics
2. **Data Storage**: Stored in PostgreSQL using R2DBC for reactive access
3. **API Layer**: Exposed via WebFlux controllers for non-blocking responses
4. **External Services**: Communicates with other services via Reactive Feign clients
