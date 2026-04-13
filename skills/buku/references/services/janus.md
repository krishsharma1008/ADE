# Janus

BukuWarung's KYC/KYB verification service handling identity verification, document processing, and fraud detection.

## GitHub Repository

https://github.com/bukuwarung/janus

## Description

Janus is BukuWarung's identity verification service named after the Roman god of beginnings and transitions. It handles Know Your Customer (KYC) and Know Your Business (KYB) verification processes including ID card OCR, face matching, liveliness detection, and document verification. The service integrates with various identity verification providers to ensure user authenticity.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 11 |
| Framework | Spring Boot 2.5.0 |
| Build Tool | Maven |
| Database | PostgreSQL |
| Caching | Redis (Redisson) |
| ORM | Hibernate, Spring Data JPA |
| Migrations | Flyway |
| Configuration | Spring Cloud Config |
| PDF Generation | Flying Saucer, FreeMarker |
| Logging | Logback, Logstash, Zalando Logbook |

## Project Structure

```
janus/
├── app/               # Application entry point and configuration
├── common/            # Shared utilities, DTOs, and constants
├── core/              # Domain logic, use cases, and services
├── persistence/       # Database entities and repositories
├── provider/          # External verification provider integrations
├── docker/            # Docker configuration
└── deployments/       # Kubernetes deployment configurations
```

## Key Features / Responsibilities

- **KTP OCR (ID Card Recognition)**:
  - Extract data from Indonesian National ID (KTP)
  - Validate ID card authenticity
  - Parse NIK (National ID Number) information

- **Face Matching**:
  - Compare selfie with ID card photo
  - Calculate similarity scores
  - Detect potential fraud

- **Liveliness Detection**:
  - Verify user is a real person (not a photo/video)
  - Anti-spoofing measures
  - Real-time verification

- **KYB (Know Your Business)**:
  - Business document verification
  - Company registration validation
  - Beneficial owner verification

- **Document Management**:
  - Store and manage verification documents
  - Generate verification reports (PDF)
  - Maintain verification audit trail

- **Risk Assessment**:
  - Flag suspicious verification attempts
  - Integration with fraud detection systems

## API Routes (via app-gateway)

| Route Pattern | Description |
|---------------|-------------|
| `/janus/**` | All Janus verification endpoints |

## Dependencies / Integrations

### Internal Services
- **multi-tenant-auth**: User authentication and account linking
- **accounting-service**: KYC status updates for user accounts
- **notification**: Verification status notifications
- **panacea**: Admin review interface for manual verification

### External Providers
- OCR service providers
- Face recognition APIs
- Liveliness detection services
- Government data verification (Dukcapil)
- AWS S3 (document storage)
- AWS (Tika for file type detection)

### Infrastructure
- **Redis**: Caching verification results
- **Spring Cloud Config**: Centralized configuration
- **ShedLock**: Distributed job scheduling

## Local Development

### Prerequisites
- Java 11
- Maven
- PostgreSQL
- Redis

### Build

```bash
# Check and apply code style
mvn spotless:apply

# Build the project
mvn clean package
```

### Run

```bash
# Start dependencies via Docker
cd docker
./build
./run

# Or run directly
mvn spring-boot:run
```

## Code Style

The project follows Google Java Style:

```bash
# Check style
mvn spotless:check

# Apply style
mvn spotless:apply
```

## Testing

```bash
# Run tests
mvn test

# Run with coverage
mvn test jacoco:report
```

## Architecture

```
┌─────────────────────────────────────────┐
│              App Layer                   │
│   (Controllers, REST Endpoints)         │
├─────────────────────────────────────────┤
│              Core Layer                  │
│   (Use Cases, Domain Services,          │
│    Verification Logic)                  │
├─────────────────────────────────────────┤
│           Adapter Layers                 │
│  ┌───────────┐  ┌──────────────────────┐│
│  │Persistence│  │      Providers       ││
│  │(Database) │  │(OCR, Face Match, etc)││
│  └───────────┘  └──────────────────────┘│
└─────────────────────────────────────────┘
```

## Verification Flow

```
User Submits Documents
         │
         ▼
   ┌───────────┐
   │  OCR/KTP  │──── Extract ID data
   └─────┬─────┘
         │
         ▼
   ┌───────────┐
   │Face Match │──── Compare photo with selfie
   └─────┬─────┘
         │
         ▼
   ┌───────────┐
   │Liveliness │──── Verify real person
   └─────┬─────┘
         │
         ▼
   ┌───────────┐
   │   Result  │──── Store verification status
   └───────────┘
```
