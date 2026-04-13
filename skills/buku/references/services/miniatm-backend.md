# MiniATM Backend

Backend service for Mini ATM product - handles transactions related to ATM card-based services for merchants.

## Repository

- **GitHub**: https://github.com/bukuwarung/miniatm-backend

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 21 |
| Framework | Spring Boot WebFlux 3.3.3 |
| Build Tool | Gradle 8.10 |
| Database | PostgreSQL (R2DBC - Reactive) |
| Message Broker | Kafka (Spring Cloud Stream) |
| API Client | Reactive Feign |
| Architecture | Hexagonal (Ports and Adapters) |
| Reactive | Project Reactor |

## Key Features / Responsibilities

- ATM card transaction processing for merchants
- Cash withdrawal operations
- Balance inquiry services
- Integration with EDC Adapter for terminal communication
- Transaction history and reporting
- Operations portal support for transaction management

## Project Structure

```
miniatm-backend/
|-- app/           # Main application entry point
|-- api/           # REST API controllers (adapters)
|-- common/        # Shared utilities and DTOs
|-- core/          # Core domain logic and business rules
|-- persistence/   # Database layer (R2DBC repositories)
|-- provider/      # External service integrations
|-- adapters/      # External adapters
|-- docs/          # Documentation
|-- deployments/   # Kubernetes deployment configs
```

## API Routes

All routes are prefixed with `/miniatm/`:

| Route Pattern | Description |
|---------------|-------------|
| `/miniatm/**` | Main MiniATM transaction endpoints |
| `/miniatm/ops/**` | Operations portal endpoints |

## Dependencies / Integrations

### Internal Services
- **EDC Adapter**: Terminal communication and ISO 8583 processing
- **Payments Service**: Settlement and payment processing
- **Kafka Topics**: Event streaming for transaction states

### External Dependencies
- **PostgreSQL**: Transaction and state persistence (via R2DBC)
- **Kafka**: Event streaming for async processing
- **AWS S3**: File storage for reports
- **AWS Secrets Manager**: Credential management

### Key Libraries
- **Spring WebFlux**: Reactive web framework
- **R2DBC PostgreSQL**: Reactive database access
- **Project Reactor**: Reactive programming
- **Spring Cloud Stream**: Kafka integration
- **Spring Cloud OpenFeign**: External API clients
- **Reactive Feign**: Non-blocking HTTP clients
- **SpringDoc OpenAPI**: Swagger documentation
- **Apache POI**: Excel file generation for reports
- **Bouncy Castle**: Cryptographic operations

## Development

### Prerequisites
- Java 21
- Gradle 8.10
- PostgreSQL
- Docker
- Kafka

### Build & Run
```bash
# Build the project
make build

# Run the application
make run
```

### API Documentation
Enable Swagger UI by setting `SWAGGER_UI_ACTIVE=true`:
```
http://localhost/miniatm/swagger-ui.html
```

### Testing
```bash
# Run unit and integration tests
./gradlew test
```

### Deployment
Deploy via Jenkins: https://jenkins-internal.dev.bukuwarung.com

## Architecture Notes

Follows **Hexagonal Architecture** (Ports and Adapters):
- **Core**: Business logic isolated from frameworks
- **Ports**: Interfaces for external world interaction
- **Adapters**:
  - `persistence`: Database interaction
  - `api`: HTTP request handling
  - `kafka`: Message broker integration
  - `provider`: External API clients
