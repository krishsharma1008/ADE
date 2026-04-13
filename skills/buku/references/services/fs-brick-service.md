# FS Brick Service

## Description

FS Brick Service is a microservice that provides integration with Brick, a financial data aggregation platform. It enables Financial Services (FS) to access bank account data, transaction history, and financial information through Brick's APIs for features like account verification, income verification, and financial analysis.

## GitHub Repository

[https://github.com/bukuwarung/fs-brick-service](https://github.com/bukuwarung/fs-brick-service)

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 11 |
| Framework | Spring Boot 2.6.3 |
| Build Tool | Gradle |
| Database | PostgreSQL (with H2 for testing) |
| ORM | Spring Data JPA |
| Documentation | SpringDoc OpenAPI / Swagger |

## Key Features / Responsibilities

- **Brick API Integration**: Connect to Brick's financial data aggregation platform
- **Bank Account Access**: Retrieve and process bank account information
- **Transaction Data**: Fetch and analyze transaction history
- **Statement Processing**: PDF parsing with Apache PDFBox and OCR with Tess4J
- **Push Notifications**: Firebase Admin SDK for notification capabilities
- **Scheduled Jobs**: ShedLock for distributed job scheduling
- **S3 Storage**: AWS S3 integration for file storage
- **Lambda Integration**: AWS Lambda client for serverless functions

## API Routes (via App Gateway)

| Route Pattern | Description |
|---------------|-------------|
| `/fs/brick/service/**` | All Brick connector operations |

## Project Structure

```
fs-brick-service/
├── src/main/java/com/bukuwarung/fsbrickservice/
│   ├── config/        # Configuration classes
│   ├── constants/     # Application constants
│   ├── controller/    # REST API controllers
│   ├── entity/        # JPA entities
│   ├── enums/         # Enumeration types
│   ├── exceptions/    # Custom exception handlers
│   ├── filter/        # Request/response filters
│   ├── mappers/       # MapStruct mappers
│   ├── model/         # DTOs and request/response models
│   ├── provider/      # External API providers
│   ├── repository/    # JPA repositories
│   ├── scheduler/     # Scheduled tasks
│   ├── service/       # Business logic layer
│   └── util/          # Utility classes
├── RFC/               # Request for Comments documentation
├── plans/             # Implementation plans
└── statements/        # Statement-related resources
```

## Dependencies / Integrations

### External Services
- **Brick Platform**: Financial data aggregation API
- **AWS S3**: File storage
- **AWS Lambda**: Serverless function execution
- **Firebase**: Push notifications

### Internal Services
- **App Gateway**: Routes traffic through `/fs/brick/service/**`
- **AWS Secrets Manager**: Secure credential management

### Key Libraries
- Spring Cloud Circuit Breaker (Resilience4j)
- MapStruct for object mapping
- Apache PDFBox for PDF processing
- Tess4J for OCR
- JWT (Auth0) for authentication
- ShedLock for distributed scheduling
- Hibernate Types for enhanced PostgreSQL support

## Development

### Requirements
- Git
- Java 11
- Gradle
- IntelliJ IDEA or Eclipse

### Code Style
Spotless gradle plugin is enabled. Run before committing:
```bash
./gradlew spotlessApply
```

### Build
```bash
./gradlew build
```

### Run Tests
```bash
./gradlew test
```
