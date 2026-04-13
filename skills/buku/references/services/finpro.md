# Finpro (Fintech Product Service)

BukuWarung's digital products service handling PPOB, bill payments, and financial product transactions.

## GitHub Repository

https://github.com/bukuwarung/finpro

## Description

Finpro (Fintech Product Service) manages digital product transactions including prepaid purchases (pulsa, data packages), bill payments (electricity, water, internet), and other financial products. It acts as an aggregator connecting BukuWarung's platform with various digital product providers.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 8 |
| Framework | Spring Boot 2.4.3 |
| Build Tool | Maven |
| Database | PostgreSQL |
| Messaging | Kafka (Spring Cloud Bus) |
| Configuration | Spring Cloud Config |
| Logging | Logback, Logstash, Zalando Logbook |
| API Documentation | OpenAPI |

## Project Structure

```
finpro/
├── client/            # Feign clients for external services
├── common/            # Shared utilities and DTOs
├── core/              # Domain logic and use cases
├── persistence/       # Database entities and repositories
├── server/            # Application entry point
└── copilot/           # AWS Copilot deployment configs
```

## Key Features / Responsibilities

- **PPOB (Payment Point Online Bank)**: Bill payments for utilities
  - Electricity (PLN prepaid/postpaid)
  - Water bills (PDAM)
  - Internet/cable TV
  - BPJS payments
- **Prepaid Products (PaymentIn)**:
  - Mobile top-up (pulsa)
  - Data packages
  - Game vouchers
  - E-money top-up
- **PaymentOut**: Outbound payment processing
- **Product Catalog**: Manage available products and pricing
- **Provider Integration**: Connect with multiple digital product aggregators
- **Transaction Tracking**: Real-time status tracking for all transactions

## API Routes (via app-gateway)

| Route Pattern | Description |
|---------------|-------------|
| `/finpro/**` | All Finpro service endpoints |

## Dependencies / Integrations

### Internal Services
- **payments**: Payment processing and wallet deductions
- **accounting-service**: Transaction recording and ledger updates
- **multi-tenant-auth**: User authentication
- **notification**: Transaction status notifications

### External Providers
- Digital product aggregators (various biller providers)
- Telco operators
- Utility companies (PLN, PDAM)

### Infrastructure
- **Kafka**: Event streaming for transaction updates
- **Spring Cloud Config**: Centralized configuration
- **Redis**: Caching for product catalogs

## Local Development

### Prerequisites
- Java 8
- Maven
- Docker (for local dependencies)

### Build

```bash
# Check and apply code style
mvn spotless:apply

# Build the project
mvn clean package
```

### Run with Docker

```bash
# Create network (if needed)
docker network create bw

# Start PostgreSQL
docker run --detach \
    --name postgres \
    --volume ${HOME}/DockerPG/finpro:/var/lib/postgresql/data \
    --publish 5432:5432 \
    --env POSTGRES_PASSWORD=SuperSecret \
    --env POSTGRES_USER=finpro \
    --network bw \
    postgres:12

# Set environment variables
export FINPRO_DB_DSN_KEY='jdbc:postgresql://postgres:5432/finpro_development?user=finpro&password=SuperSecret'
export DB_SCHEMA=development

# Run the application
docker-compose --file docker-compose.local.yml up --build
```

## Code Style

The project follows Google Java Style:

```bash
# Check style
mvn spotless:check

# Apply style
mvn spotless:apply
```

## Architecture

The service uses Hexagonal (Ports & Adapters) architecture following the pattern described in [Hexagonal Architecture with Java and Spring](https://reflectoring.io/spring-hexagonal/).

```
┌────────────────────────────────────────┐
│              Server Layer               │
├────────────────────────────────────────┤
│               Core Layer                │
│   (Domain Logic, Use Cases, Ports)     │
├────────────────────────────────────────┤
│            Adapter Layers               │
│  ┌──────────┐  ┌──────────┐  ┌──────┐  │
│  │ Client   │  │Persistence│  │Common│  │
│  │(External)│  │(Database) │  │      │  │
│  └──────────┘  └──────────┘  └──────┘  │
└────────────────────────────────────────┘
```

## Development Guidelines

1. All PRs must be merged with squash
2. Configuration via environment variables (never hardcoded)
3. Update `docker-compose.local.yml` and Copilot `manifest.yml` when adding new env variables
4. Follow Google Java Style for all code

## Documentation

- [System Design Documentation](https://bukuwarung.atlassian.net/wiki/spaces/tech/pages/451150149/Fintech+Product+System+Design)
