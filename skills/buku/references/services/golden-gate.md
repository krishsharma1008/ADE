# Golden Gate

BukuWarung's payment portal backend service that powers the Panacea internal dashboard.

## GitHub Repository

https://github.com/bukuwarung/golden-gate

## Description

Golden Gate is the backend service for the Panacea payment portal. It provides APIs for internal operations including transaction management, user administration, payment operations, and reporting. The service acts as a gateway between the Panacea frontend and various backend microservices.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 11 |
| Framework | Spring Boot 2.7.3 |
| Build Tool | Gradle |
| Database | PostgreSQL |
| ORM | Spring Data JPA, Hibernate |
| API Documentation | SpringDoc OpenAPI (Swagger) |
| Cloud | AWS (SNS, Secrets Manager) |
| Scheduling | ShedLock |

## Project Structure

```
golden-gate/
├── app/              # Application entry point and configuration
├── buildSrc/         # Gradle build configuration
├── common/           # Shared utilities, DTOs, and constants
├── core/             # Business logic and domain services
├── persistence/      # Database entities and repositories
├── provider/         # External service integrations
├── plans/            # Development plans and documentation
└── deployments/      # Kubernetes deployment configurations
```

## Key Features / Responsibilities

- **Transaction Management**: View, search, and manage payment transactions
- **User Administration**: Internal user and merchant management APIs
- **Payment Operations**: Process disbursements, refunds, and adjustments
- **Reporting APIs**: Generate transaction reports and analytics data
- **File Processing**: CSV/Excel report generation and processing
- **Google Drive Integration**: Document storage and retrieval
- **Scheduled Jobs**: Automated report generation and data synchronization
- **Audit Logging**: Track all administrative actions

## API Routes (via app-gateway)

| Route Pattern | Description |
|---------------|-------------|
| `/golden-gate/**` | All Golden Gate API endpoints |

## Dependencies / Integrations

### Internal Services
- **payments**: Core payment processing service
- **accounting-service**: Transaction and ledger data
- **multi-tenant-auth**: Authentication and user management
- **janus**: KYC/KYB verification data
- **notification**: Sending notifications

### External Services
- **Google Drive API**: Document storage
- **Google Auth**: Service authentication
- **AWS SNS**: Event notifications
- **AWS Secrets Manager**: Credential management

## Local Development

```bash
# Build the project
./gradlew clean build

# Run the application
./gradlew :app:bootRun

# Run with specific profile
./gradlew :app:bootRun --args='--spring.profiles.active=local'
```

## Code Style

The project uses Google Java Format. Check and apply formatting:

```bash
# Check formatting
./gradlew spotlessCheck

# Apply formatting
./gradlew spotlessApply
```

## Testing

```bash
# Run all tests
./gradlew test

# Run with coverage report
./gradlew test jacocoTestReport
```

## API Documentation

When running locally, Swagger UI is available at:
- http://localhost:8080/swagger-ui.html
