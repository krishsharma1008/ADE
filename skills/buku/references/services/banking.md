# Banking

## Description

Banking is a microservice application for banking operations at BukuWarung. Built with JHipster, it provides core banking functionalities including account management, money transfers, balance inquiries, and other banking-related operations. The service uses a reactive architecture for high-performance, non-blocking operations.

## GitHub Repository

[https://github.com/bukuwarung/banking](https://github.com/bukuwarung/banking)

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 11 |
| Framework | Spring Boot (JHipster 7.1.0) |
| Build Tool | Gradle 7.0.2 |
| Database | PostgreSQL (R2DBC - Reactive) |
| Migration | Liquibase |
| API Docs | Springfox Swagger/OpenAPI |
| Testing | JUnit 5, Cucumber, Gatling |

## Key Features / Responsibilities

- **Account Management**: Create and manage user bank accounts
- **Balance Operations**: Check balances, process deposits and withdrawals
- **Money Transfers**: Handle peer-to-peer and external transfers
- **Transaction Processing**: Process and record banking transactions
- **JWT Authentication**: Secure API access with JWT tokens
- **API-First Development**: OpenAPI-based API design
- **Reactive Architecture**: Built with Spring WebFlux and R2DBC

## API Routes (via App Gateway)

| Route Pattern | Description |
|---------------|-------------|
| `/banking/services/**` | All banking operation endpoints |

## Project Structure

```
banking/
├── src/main/java/com/bukuwarung/banking/
│   ├── aop/           # Aspect-oriented programming (logging, etc.)
│   ├── config/        # Configuration classes
│   ├── domain/        # Domain entities
│   ├── repository/    # R2DBC repositories
│   ├── security/      # Security configuration and JWT handling
│   ├── service/       # Business logic layer
│   └── web/           # REST API controllers
├── src/main/resources/
│   ├── config/        # Application configuration
│   └── swagger/       # OpenAPI specification (api.yml)
├── docker-compose/    # Docker compose files
└── gradle/            # Gradle configuration
```

## Dependencies / Integrations

### External Services
- **Payment Providers**: Integration with various payment gateways

### Internal Services
- **App Gateway**: Routes traffic through `/banking/services/**`
- **Spring Cloud**: Service discovery and configuration
- **Hystrix**: Circuit breaker for fault tolerance

### Key Libraries
- JHipster Framework
- Spring WebFlux for reactive REST APIs
- Spring Data R2DBC for reactive database access
- Spring Security with JWT
- Liquibase for database migrations
- MapStruct for object mapping
- Springfox for API documentation
- Micrometer with Prometheus for metrics

## Development

### Requirements
- Git
- Java 11
- Gradle 7.0.2
- PostgreSQL
- Node.js (for frontend tools)

### Build
```bash
./gradlew
```

### Run Tests
```bash
./gradlew test integrationTest jacocoTestReport
```

### API-First Development
Generate API code from OpenAPI specification:
```bash
./gradlew openApiGenerate
```

Edit the API definition using Swagger Editor:
```bash
docker-compose -f src/main/docker/swagger-editor.yml up -d
# Access at http://localhost:7742
```

### Docker Support
Start PostgreSQL:
```bash
docker-compose -f src/main/docker/postgresql.yml up -d
```

Build and run the application:
```bash
./gradlew bootJar -Pprod jibDockerBuild
docker-compose -f src/main/docker/app.yml up -d
```

### Code Quality
Run SonarQube analysis:
```bash
docker-compose -f src/main/docker/sonar.yml up -d
./gradlew -Pprod clean check jacocoTestReport sonarqube
```

## Architecture

The service is built as a JHipster microservice with:
- Reactive WebFlux stack
- R2DBC for non-blocking database operations
- JWT-based authentication
- OpenAPI/Swagger for API documentation
- Service discovery integration
