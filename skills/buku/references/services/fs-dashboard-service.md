# FS Dashboard Service

## Description

FS Dashboard Service is a backend microservice that powers the Financial Services dashboard. It provides APIs for managing and displaying financial services data, including BNPL (Buy Now Pay Later) related information, loan applications, and financial product analytics for internal operations teams.

## GitHub Repository

[https://github.com/bukuwarung/fs-dashboard-service](https://github.com/bukuwarung/fs-dashboard-service)

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 11 |
| Framework | Spring Boot 2.6.3 |
| Build Tool | Gradle |
| Database | PostgreSQL (with H2 for testing) |
| ORM | Spring Data JPA |
| Migration | Flyway |
| Documentation | SpringDoc OpenAPI / Swagger |

## Key Features / Responsibilities

- **Dashboard APIs**: Provide backend APIs for FS dashboard frontend
- **Data Aggregation**: Aggregate and present financial services data
- **BNPL Management**: Support BNPL (Buy Now Pay Later) operations
- **Reporting**: Generate reports and analytics for financial products
- **User Management**: Handle dashboard user access and permissions
- **Data Export**: Support data export functionalities

## API Routes (via App Gateway)

| Route Pattern | Description |
|---------------|-------------|
| `/fs-dashboard/**` | All Financial Services dashboard operations |

## Project Structure

```
fs-dashboard-service/
├── src/main/java/com/bukuwarung/fsdashboard/
│   ├── config/        # Configuration classes
│   ├── constant/      # Application constants
│   ├── controller/    # REST API controllers
│   ├── entity/        # JPA entities
│   ├── enums/         # Enumeration types
│   ├── filter/        # Request/response filters
│   ├── mapper/        # Object mappers
│   ├── repository/    # JPA repositories
│   ├── request/       # Request DTOs
│   ├── response/      # Response DTOs
│   ├── service/       # Business logic layer
│   └── util/          # Utility classes
└── deployments/       # Deployment configurations
```

## Dependencies / Integrations

### External Services
- **AWS Secrets Manager**: Secure database credential management

### Internal Services
- **App Gateway**: Routes traffic through `/fs-dashboard/**`
- **FS BNPL Service**: May integrate with BNPL service for loan data
- **FS Brick Service**: May integrate for financial data

### Key Libraries
- Spring Data JPA for database operations
- Flyway for database migrations
- ModelMapper for object mapping
- OkHttp for HTTP client operations
- Gson for JSON processing
- Hibernate Types for enhanced PostgreSQL support
- Mockito for testing

## Development

### Requirements
- Git
- Java 11
- Gradle
- IntelliJ IDEA or Eclipse

### Build
```bash
./gradlew build
```

### Run Tests
```bash
./gradlew test
```

### Database Migrations
Flyway is configured for database migrations. Migrations are automatically applied on startup.
