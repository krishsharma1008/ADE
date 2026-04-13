# User Trust

User trust and fraud detection service for BukuWarung platform.

## Repository

- **GitHub**: https://github.com/bukuwarung/user-trust
- **Architecture Document**: [Confluence - Architecture of User Trust Service](https://bukuwarung.atlassian.net/wiki/spaces/UT/pages/1161887745/Architecture+of+User+Trust+Service)

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 11 |
| Framework | Spring Boot 2.7.3 |
| Build Tool | Gradle 7.5 |
| Database | PostgreSQL |
| Cache | Redis (Redisson) |
| ORM | Spring Data JPA, Hibernate |
| Architecture | Hexagonal (Ports and Adapters) |

## Key Features / Responsibilities

- User trust score calculation and management
- Fraud detection and prevention
- Risk assessment for user transactions
- Rule-based trust evaluation via rule-engine module
- Integration with external risk assessment services
- Real-time trust score updates

## Project Structure

```
user-trust/
|-- core/           # Core domain logic and business rules
|-- risk-service/   # Risk assessment service implementation
|-- rule-engine/    # Rule-based evaluation engine
|-- deployments/    # Kubernetes deployment configurations
```

## API Routes

All routes are prefixed with `/user-trust/`:

| Route Pattern | Description |
|---------------|-------------|
| `/user-trust/**` | User trust score and risk assessment endpoints |

## Dependencies / Integrations

### Internal Services
- **Rule Engine**: Built-in rule engine for trust score calculation
- **Risk Service**: Internal risk assessment module

### External Dependencies
- **PostgreSQL**: Primary data storage
- **Redis**: Caching for trust scores and session data
- **AWS Secrets Manager**: Credential management

## Development

### Prerequisites
- Git
- Java 11
- Gradle 7.5
- IntelliJ IDEA (recommended for Lombok support)

### Build & Test
```bash
# Format code before committing
./gradlew spotlessJavaApply

# Build and run tests
./gradlew clean build
```

### Code Style
- Spotless gradle plugin for code formatting
- Hexagonal architecture pattern
- Unit tests are required for all business logic

### Git Branching Strategy
- Create release and dev branch from master at sprint start
- Feature branches created from release
- Merge to dev for testing, then to release for staging
- Release branch deployed to production, then merged to master
