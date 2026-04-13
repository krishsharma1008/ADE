# Retail Backend

BukuPay Retail service - handles QRIS (Quick Response Code Indonesian Standard) transactions for merchants.

## Repository

- **GitHub**: https://github.com/bukuwarung/retail-backend

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 21 |
| Framework | Spring Boot WebFlux 3.3.3 |
| Build Tool | Gradle 8.10 |
| Database | PostgreSQL (R2DBC - Reactive) |
| Message Broker | Kafka (Reactor Kafka) |
| Cache | Redis (Redisson) |
| IoT | AWS IoT / MQTT |
| Scheduler | ShedLock (Distributed) |
| Architecture | Hexagonal (Ports and Adapters) |
| Reactive | Project Reactor |

## Key Features / Responsibilities

- QRIS payment processing for retail merchants
- Order management and transaction processing
- Settlement synchronization with external providers
- KYC/KYB (Know Your Customer/Business) integration
- Business and merchant management
- Product catalog and inventory management
- Voucher and promotion management
- Delivery integration (Biteship)
- Bank account management
- Notification services

## Project Structure

```
retail-backend/
|-- app/           # Main application (com.bukuwarung.retail.Main)
|-- api/           # REST controllers, webhooks, DTOs
|-- common/        # Shared utilities, events, provider interfaces
|-- core/          # Core domain logic and business services
|-- persistence/   # Database layer (R2DBC, Flyway migrations)
|-- provider/      # External service integrations
|-- docs/          # Documentation
|-- deployments/   # Kubernetes deployment configs
```

### Core Services Organization
```
core/application/service/
|-- order/         # Order processing
|-- transaction/   # Transaction management
|-- settlement/    # Settlement sync
|-- kyckyb/        # KYC/KYB verification
|-- business/      # Business management
|-- product/       # Product catalog
|-- inventory/     # Stock management
|-- voucher/       # Voucher processing
|-- delivery/      # Delivery tracking
|-- banks/         # Bank integrations
|-- auth/          # Authentication
|-- notification/  # Notifications
|-- file/          # File operations
```

## API Routes

All routes are prefixed with `/bukupay/retail/`:

| Route Pattern | Description |
|---------------|-------------|
| `/bukupay/retail/**` | BukuPay Retail API endpoints |

### Webhook Endpoints
- Dana webhook handlers
- Nobu webhook handlers

## Dependencies / Integrations

### Internal Services
- **Payments Service**: Payment processing
- **Accounting Service**: Financial reconciliation
- **Notification Service**: Push notifications
- **Kafka Topics**: Event streaming

### External Dependencies
- **Dana**: QRIS payment provider
- **Nobu**: Payment provider
- **Biteship**: Delivery service (Komerce)
- **PostgreSQL**: Transaction persistence (via R2DBC)
- **Redis**: Caching and session management
- **Kafka**: Event streaming
- **AWS S3**: File storage
- **AWS Lambda**: Serverless functions
- **AWS IoT**: MQTT messaging
- **Datadog**: APM monitoring

### Key Libraries
- **Spring WebFlux**: Reactive web framework
- **R2DBC PostgreSQL**: Reactive database access
- **Reactor Kafka**: Reactive Kafka client
- **Redisson**: Redis client
- **Reactive Feign**: Non-blocking HTTP clients
- **ShedLock**: Distributed scheduler locking
- **SpringDoc OpenAPI**: Swagger documentation
- **Apache POI**: Excel file generation
- **ZXing**: QR code generation
- **Apache PDFBox**: PDF generation
- **JWT (jjwt)**: Token handling

## Development

### Prerequisites
- Java 21
- Gradle 8.10
- PostgreSQL
- Kafka
- Redis
- Docker

### Build & Run
```bash
# Full build with tests and formatting
make build

# Build without tests
make build-no-test

# Run the application
make run
```

### API Documentation
Enable Swagger UI by setting `SWAGGER_UI_ACTIVE=true`:
```
http://localhost/retail/swagger-ui.html
```

### Testing
```bash
# Run all tests
./gradlew test

# Run with coverage
./gradlew test jacocoTestReport

# Merged coverage report
./gradlew jacocoMergedReport
```

### Code Quality
```bash
# Format code
./gradlew spotlessApply

# Check formatting
./gradlew spotlessCheck

# SonarQube analysis
./gradlew sonarqube
```

### Database Migrations
Location: `adapters/persistence/src/main/resources/db/migration/`
Naming: `v{YYYYMMDD}{sequence}__{description}.sql`

### Deployment
Deploy via Jenkins: https://jenkins-internal.dev.bukuwarung.com

## Configuration

Key environment variables (see `.env.example`):
- **Database**: `R2DBC_DB_URL`, `R2DBC_DB_USERNAME`, `R2DBC_DB_PASSWORD`
- **Server**: `SERVER_PORT` (default: 8002)
- **Kafka**: `KAFKA_BROKERS`, `KAFKA_CONSUMER_ENABLED`
- **AWS**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_RETAIL_BUCKET`

## Architecture Notes

Follows **Hexagonal Architecture**:
- `core` depends only on `common` (no adapter dependencies)
- `adapters/*` can depend on `core` and `common`
- `app` depends on all modules for wiring
- All database and HTTP operations use reactive types (`Mono<T>`, `Flux<T>`)
