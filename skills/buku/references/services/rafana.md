# Rafana (Rafana Wrapper)

Rafana B2B service for BukuWarung platform - provides B2B integrations and partner APIs.

## Repository

- **GitHub**: https://github.com/bukuwarung/rafana-wrapper
- **API Documentation**: `/rafana-wrapper/docs/swagger-ui/index.html`

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 17 |
| Framework | Spring Boot 3.1.1 |
| Build Tool | Gradle |
| Database | PostgreSQL |
| Migrations | Flyway 9.0.1 |
| ORM | Spring Data JPA |
| API Client | Spring Cloud OpenFeign |
| Architecture | Hexagonal (Ports and Adapters) |

## Key Features / Responsibilities

- B2B partner integrations and APIs
- Sandbox environment for partner testing
- Partner authentication and authorization
- Digital product management for B2B clients
- API wrapper services for internal systems

## Project Structure

```
rafana-wrapper/
|-- app/                  # Main application entry point
|-- common/               # Shared utilities and DTOs
|-- core/                 # Core business logic
|-- provider/             # External provider integrations
|-- persistence/          # Database layer
|-- sandbox/              # Sandbox/test environment
|-- deployments/          # Production deployment configs
|-- deployments-sandbox/  # Sandbox deployment configs
|-- copilot/              # AWS Copilot configurations
```

## API Routes

All routes are prefixed with `/rafana/`:

| Route Pattern | Description |
|---------------|-------------|
| `/rafana/**` | Main Rafana B2B API endpoints |
| `/rafana/partner/**` | Partner-specific API endpoints |
| `/rafana-sandbox/**` | Sandbox environment for partner testing |

## Dependencies / Integrations

### Internal Services
- **BW Common Logger**: Centralized logging library (`bwcommonlogger:1.6-RELEASE`)
- Internal digital product services

### External Dependencies
- **PostgreSQL**: Primary data storage
- **AWS Secrets Manager**: Credential management
- **AWS CodeArtifact**: Internal Java packages repository

### Libraries
- Spring Security for authentication
- Spring Cache for caching
- SpringDoc OpenAPI for API documentation
- MapStruct for object mapping
- Semver4j for version management

## Development

### Prerequisites
- Java 17
- Gradle
- AWS CodeArtifact access (for internal dependencies)

### Build & Run
```bash
# Build the project
./gradlew clean build

# Run the application
./gradlew bootRun
```

### Code Style
- Spotless plugin for code formatting
- Run `./gradlew spotlessApply` before committing
