# Payments Service

BukuWarung's core payment processing service handling disbursements, virtual accounts, and transaction management.

## GitHub Repository

https://github.com/bukuwarung/payments

## Description

The Payments service is the central payment processing engine for BukuWarung. It handles various payment operations including disbursements, virtual account management, payment collection, and transaction reconciliation. The service integrates with multiple payment providers and supports high-throughput transaction processing.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 8 |
| Framework | Spring Boot 2.3.1 |
| Build Tool | Maven |
| Database | PostgreSQL |
| Caching | Redis (Redisson) |
| ORM | Hibernate, Spring Data JPA |
| Migrations | Flyway |
| Messaging | Kafka (Spring Cloud Bus) |
| API Documentation | SpringDoc OpenAPI |
| Configuration | Spring Cloud Config |

## Project Structure

```
payments/
├── adapters/
│   ├── api/           # REST API layer
│   ├── caching/       # Redis caching adapters
│   ├── consumer/      # Kafka consumers
│   ├── persistence/   # Database repositories
│   ├── provider/      # Payment provider integrations
│   └── publisher/     # Kafka publishers
├── common/            # Shared utilities and DTOs
├── core/              # Domain logic and use cases
├── server/            # Application entry point
└── docs/              # Documentation
```

## Key Features / Responsibilities

- **Disbursements**: Send money to bank accounts and e-wallets
- **Virtual Accounts**: Create and manage virtual accounts for payment collection
- **Payment Collection**: Process incoming payments
- **Transaction Management**: Track and manage all payment transactions
- **Reconciliation**: Match and reconcile transactions with providers
- **Multi-provider Support**: Integration with various payment gateways
- **Retry Mechanisms**: Automatic retry for failed transactions
- **Webhook Handling**: Process callbacks from payment providers
- **Rate Limiting**: Protect against abuse

## API Routes (via app-gateway)

| Route Pattern | Description |
|---------------|-------------|
| `/payments/**` | Payment service endpoints |
| `/api/payments/**` | API v2 payment endpoints |

## Dependencies / Integrations

### Internal Services
- **accounting-service**: Ledger updates, transaction records
- **multi-tenant-auth**: Authentication and authorization
- **notification**: Payment notifications to users
- **finpro**: Digital product payment integration

### External Payment Providers
- **Xendit**: Primary payment gateway
- **DOKU**: Alternative payment provider
- **Various Banks**: Direct bank integrations

### Infrastructure
- **Redis**: Transaction caching, rate limiting
- **Kafka**: Event streaming, async processing
- **Spring Cloud Config**: Centralized configuration

## Local Development

### Prerequisites
- Java 8
- Maven 3.8+
- PostgreSQL
- Redis

### Build

```bash
# Check code style
mvn spotless:check

# Apply code style
mvn spotless:apply

# Build the project
mvn clean package
```

### Test

```bash
# Run unit tests
mvn clean test
```

### Run

```bash
# Run the application
java -jar server/target/server-1.0.0.jar
```

## Code Style

The project follows Google Java Style. Style is enforced via Spotless plugin:

```bash
# Check style
mvn spotless:check

# Apply style
mvn spotless:apply
```

Pre-commit hooks are available for automatic style checking.

## API Documentation

When running locally, Swagger UI is available at:
- `/docs/payments/swagger-ui`

## Architecture

The service follows Hexagonal (Ports & Adapters) architecture:

```
┌─────────────────────────────────────────────┐
│                   Adapters                   │
│  ┌─────┐  ┌─────────┐  ┌──────────────────┐ │
│  │ API │  │Consumer │  │    Providers     │ │
│  └──┬──┘  └────┬────┘  └────────┬─────────┘ │
│     │          │                │           │
│  ┌──┴──────────┴────────────────┴──┐        │
│  │            Core (Domain)         │        │
│  │   Use Cases, Domain Services    │        │
│  └──────────────┬──────────────────┘        │
│                 │                           │
│  ┌──────────────┴──────────────────┐        │
│  │     Persistence / Publisher      │        │
│  └──────────────────────────────────┘        │
└─────────────────────────────────────────────┘
```

## Roadmap

- [ ] Refactor SendMoney flow (post Invoice implementation)
- [ ] Move notification to Notification Service
- [ ] Implement worker and event bus
- [ ] Move out Xendit specific code from core domain
- [ ] Generalize master balance usage tracking
