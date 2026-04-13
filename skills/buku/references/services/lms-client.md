# LMS Client

## Description

LMS Client Service is a microservice for integrating with Hypercore Loan Management System (LMS). It provides a bridge between BukuWarung's lending platform and Hypercore's loan management capabilities, enabling loan origination, servicing, and management operations.

## GitHub Repository

[https://github.com/bukuwarung/lms-client](https://github.com/bukuwarung/lms-client)

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 11 |
| Framework | Spring Boot 2.6.3 (WebFlux - Reactive) |
| Build Tool | Gradle 7.2 |
| Database | PostgreSQL (with AWS Secrets Manager JDBC) |
| Documentation | SpringDoc OpenAPI / Swagger |

## Key Features / Responsibilities

- **Hypercore LMS Integration**: Connect to and communicate with Hypercore's Loan Management System
- **Loan Operations**: Handle loan-related operations through the Hypercore platform
- **Reactive Architecture**: Built with Spring WebFlux for non-blocking, reactive operations
- **Circuit Breaker Pattern**: Uses Resilience4j for fault tolerance and resilience
- **Document Management**: Persistence layer for loan-related documents

## API Routes (via App Gateway)

| Route Pattern | Description |
|---------------|-------------|
| `/lmsclient/**` | All LMS client operations |

## Project Structure

```
lms-client/
├── application/     # Main application module
├── commons/         # Shared utilities and models
├── persistence/     # Database and data access layer
├── provider/        # External service providers/clients
└── service/         # Business logic layer
```

## Dependencies / Integrations

### External Services
- **Hypercore LMS**: Primary integration for loan management functionality

### Internal Services
- **AWS Secrets Manager**: For secure credential management
- **App Gateway**: Routes traffic through `/lmsclient/**`

### Key Libraries
- Spring Cloud Circuit Breaker (Resilience4j)
- Jackson for JSON processing
- Lombok for boilerplate reduction
- JUnit 5 for testing
- Mockito for mocking

## Development

### Requirements
- Git
- Java 11
- Gradle 7.2
- IntelliJ IDEA or Eclipse

### Code Style
Spotless gradle plugin is enabled. Run before committing:
```bash
./gradlew spotlessApply
```

### Build
```bash
./gradlew build
```

## References

- [RFC - Integration with LMS Hypercore](https://bukuwarung.atlassian.net/wiki/spaces/LEN/pages/1001619888/RFC-+Integration+with+LMS+Hypercore)
