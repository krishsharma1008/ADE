# Business Rules Engine (rule-engine)

## Description

The Business Rules Engine is a Spring Boot service that provides dynamic business rule evaluation for BukuWarung's payment services. It uses Drools as the underlying rule engine to enable dynamic routing, decision-making, and business logic execution without requiring code changes.

## GitHub Repository

https://github.com/bukuwarung/rule-engine

## Tech Stack

- **Language**: Java 11
- **Framework**: Spring Boot 2.6.7
- **Build Tool**: Gradle
- **Rule Engine**: Drools 7.49.0
- **Database**: PostgreSQL
- **ORM**: Spring Data JPA
- **Cloud Config**: Spring Cloud Config Client
- **Messaging**: Spring Cloud Bus Kafka
- **Code Style**: Google Java Format (Spotless)

## Key Features/Responsibilities

- Dynamic routing for payment transactions
- Business rule evaluation and execution
- Decision tables support for complex routing logic
- Real-time rule updates via Spring Cloud Bus
- Load balancing capabilities for rule-based routing
- Kafka integration for event-driven rule processing
- Metrics and monitoring via Datadog

## API Routes

- **Base Path**: `/rule-engine/**`
- REST APIs documented via SpringDoc OpenAPI and Swagger

## Project Structure

```
app/           # Main application module
api/           # REST API controllers and DTOs
common/        # Shared utilities and common code
core/          # Core business logic
  - Drools rule compilation and execution
  - Decision table processing
loadbalancer/  # Load balancing logic for routing
persistence/   # Database entities and repositories
providers/     # External service integrations
  - S3 integration for rule file storage
  - OkHttp client for external API calls
```

## Drools Integration

The service uses Drools for:
- Rule compilation (`drools-compiler`)
- Decision tables (`drools-decisiontables`)
- MVEL expression language (`drools-mvel`)
- KIE API for rule session management

## Dependencies/Integrations

- **PostgreSQL**: Primary database for rule storage
- **AWS S3**: Storage for rule definition files (DRL files, decision tables)
- **Kafka**: Event streaming for rule refresh notifications
- **Spring Cloud Config**: Externalized configuration management
- **Datadog**: Metrics and monitoring (java-dogstatsd-client)
- **Firebase**: Authentication integration

## Configuration

The service integrates with:
- Spring Cloud Config Server for centralized configuration
- Kafka for config refresh events via Spring Cloud Bus
- AWS Secrets Manager for secure credential management

## Development

### Prerequisites
- Java 11
- Gradle

### Build

```bash
# Build the application
make build

# Or using Gradle directly
./gradlew build
```

### Code Style

```bash
# Apply Google Java Format
./gradlew spotlessApply
```

### Run

```bash
java -jar app/build/libs/app-1.0.0.jar
```

## Documentation

- [Architecture Documentation](https://bukuwarung.atlassian.net/wiki/spaces/tech/pages/1001849097/RFC-DynamicRouting#Architecture-Changes)
- [PRD Dynamic Routing](https://bukuwarung.atlassian.net/wiki/spaces/PAYM/pages/801309296/PRD+Dynamic+Routing)

## Deployment

- Deployed via Jenkins CI/CD pipeline
- Containerized using Docker
- Deployed to AWS ECS using Copilot
