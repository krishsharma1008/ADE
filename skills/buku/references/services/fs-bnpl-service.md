# Financial Services BNPL Service (fs-bnpl-service)

## Description

The Financial Services BNPL (Buy Now Pay Later) Service is a Spring Boot application that handles merchant onboarding and BNPL-related functionality for BukuWarung's lending products. It manages merchant eligibility, credit limits, document processing, and integration with lending partners.

## GitHub Repository

https://github.com/bukuwarung/fs-bnpl-service

## Tech Stack

- **Language**: Java 11
- **Framework**: Spring Boot 2.6.3
- **Build Tool**: Gradle
- **Database**: PostgreSQL, H2 (testing)
- **ORM**: Spring Data JPA, Hibernate
- **Migration**: Flyway 7.1.1
- **Job Scheduling**: Quartz
- **PDF Processing**: Flying Saucer PDF, Apache PDFBox
- **Excel Processing**: Apache POI
- **Code Style**: Google Java Format (Spotless)

## Key Features/Responsibilities

- Merchant onboarding for BNPL products
- Credit limit management (parent-merchant limits)
- Document generation and validation (PDF, Excel)
- Phone number validation and formatting
- Email notifications via AWS SES
- Firebase push notifications
- PPOB BNPL reminders
- Telco BNPL reminders
- Job scheduling for batch operations
- S3 file storage for documents

## API Routes

- **Base Path**: `/merchant-onboarding/**`
- REST APIs documented via SpringDoc OpenAPI

## Project Structure

```
src/main/java/com/bukuwarung/fsbnplservice/
  config/         # Application configuration
  controller/     # REST API controllers
  dto/            # Data transfer objects
  entity/         # JPA entities
  enums/          # Enumeration types
  filter/         # Request filters
  model/          # Domain models
  poi/            # Excel generation (Apache POI)
  repository/     # JPA repositories
  service/        # Business logic services
  util/           # Utility classes
docs/             # API documentation
RFC/              # Request for Comments documents
plans/            # Implementation plans
requirements/     # Business requirements
```

## Dependencies/Integrations

- **PostgreSQL**: Primary database with AWS Secrets Manager JDBC integration
- **AWS S3**: Document and file storage
- **AWS SES**: Email notification service
- **Firebase Admin**: Push notifications and authentication
- **Amplitude**: User analytics and event tracking
- **Apache POI**: Excel file generation (merchant data exports)
- **Flying Saucer PDF**: PDF document generation
- **Apache PDFBox**: PDF validation and processing
- **Apache Tika**: File type detection and validation
- **Quartz Scheduler**: Background job scheduling
- **Freemarker**: Email template rendering
- **libphonenumber**: Phone number validation and formatting
- **OWASP HTML Sanitizer**: Input sanitization for security

## Scheduled Jobs

- PPOB BNPL payment reminders
- Telco BNPL payment reminders
- Batch processing jobs via Quartz

## Document Processing

The service handles:
- PDF generation for merchant agreements
- PDF validation for uploaded documents
- Excel exports for merchant limit data
- Template-based email generation

## Development

### Build

```bash
make build

# Or using Gradle
./gradlew build
```

### Run

```bash
./gradlew bootRun

# With debug enabled
./gradlew bootRun -Pdebug
```

### Code Style

```bash
./gradlew spotlessApply
```

### Testing

```bash
./gradlew test
```

## Deployment

- Deployed via Jenkins CI/CD pipeline
- Containerized using Docker
- Deployed to AWS ECS using Copilot
- Uses Datadog Java Agent for APM (dd-java-agent-1.5.0.jar)
