# LOS Lender

Loan Origination System - 3rd party lender integration service. Handles integration between external lending partners and BukuWarung's financial services.

## Repository

- **GitHub**: https://github.com/bukuwarung/los-lender

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 11 |
| Framework | Spring Boot 2.6.3 |
| Build Tool | Gradle |
| Database | PostgreSQL, H2 (development) |
| Message Broker | Kafka |
| ORM | Spring Data JPA |
| HTTP Client | Spring WebFlux (WebClient) |
| Architecture | Hexagonal (Ports and Adapters) |

## Key Features / Responsibilities

- Third-party lender integration and management
- Loan application processing and routing
- Lender API abstraction layer
- Circuit breaker patterns for resilience
- Async communication with lending partners via Kafka
- Loan status synchronization

## Project Structure

```
los-lender/
|-- src/main/java/com/bukuwarung/loslender/
|   |-- LosLenderApplication.java  # Main application entry
|   |-- application/               # Application services layer
|   |-- domain/                    # Domain models and business logic
```

## API Routes

All routes are prefixed with `/los/`:

| Route Pattern | Description |
|---------------|-------------|
| `/los/**` | Loan Origination System API endpoints |

## Dependencies / Integrations

### Internal Services
- **LOS Web**: Frontend for loan management
- **LMS Client**: Loan Management System client
- **Kafka Topics**: Event streaming for loan status updates

### External Dependencies
- **PostgreSQL**: Loan application persistence
- **H2**: In-memory database for development
- **Kafka**: Event-driven communication
- **3rd Party Lenders**: External lending partner APIs

### Key Libraries
- **Spring Data JPA**: Database access
- **Spring WebFlux**: Reactive HTTP client
- **Spring Kafka**: Kafka integration
- **Resilience4j**: Circuit breaker patterns (via Spring Cloud)

## Development

### Prerequisites
- Java 11
- Gradle
- PostgreSQL (production)
- Kafka

### Build & Run
```bash
# Build the project
./gradlew clean build

# Run tests
./gradlew test

# Run the application
./gradlew bootRun
```

### Testing
```bash
# Run all tests
./gradlew test
```

## Architecture Notes

### Hexagonal Architecture
The codebase follows Hexagonal Architecture (Ports and Adapters) pattern:
- **Domain Layer**: Core business logic for lender integration
- **Application Layer**: Use cases and orchestration
- **Adapter Layer**: External lender API clients, database, Kafka

### References
1. https://reflectoring.io/spring-hexagonal/
2. https://medium.com/idealo-tech-blog/hexagonal-ports-adapters-architecture-e3617bcf00a0

### Resilience Patterns
- Uses Resilience4j Circuit Breaker for external lender API calls
- Reactor-based resilience for async operations
