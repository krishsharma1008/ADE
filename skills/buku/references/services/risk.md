# Risk Assessment Service (risk)

## Description

The Risk Assessment Service is a Spring Boot application that provides risk evaluation and assessment capabilities for BukuWarung's platform. It analyzes transactions and user activities to detect and prevent fraudulent behavior, assess creditworthiness, and manage risk-related decisions.

## GitHub Repository

https://github.com/bukuwarung/risk

## Tech Stack

- **Language**: Java 11
- **Framework**: Spring Boot 2.5.6
- **Build Tool**: Gradle
- **Database**: PostgreSQL
- **ORM**: Spring Data JPA, Hibernate
- **Migration**: Flyway 7.9.1
- **Messaging**: Kafka (Spring Cloud Stream)
- **Code Style**: Google Java Format (Spotless)

## Key Features/Responsibilities

- Risk assessment for transactions and user activities
- Fraud detection and prevention
- Credit risk evaluation
- User trust scoring
- Real-time risk monitoring via Kafka event processing
- Integration with Firebase for user authentication
- AWS Secrets Manager integration for secure credential management

## API Routes

- **Base Path**: `/risk/**`
- REST APIs documented via SpringDoc OpenAPI

## Project Structure

```
app/           # Main application module
  api/         # REST API controllers
  config/      # Application configuration
common/        # Shared utilities and common code
core/          # Business logic and domain services
persistence/   # Database entities, repositories, and migrations
provider/      # External service integrations
  - AWS SDK integrations
  - Kafka message producers/consumers
  - Firebase integration
```

## Dependencies/Integrations

- **PostgreSQL**: Primary database with AWS Secrets Manager JDBC integration
- **Kafka**: Event streaming for real-time risk processing (Spring Cloud Stream)
- **Firebase Admin**: User authentication and verification
- **AWS SDK**: Cloud service integrations
- **BW Common Logger**: Internal logging library (bwcommonlogger)

## Configuration

The service uses Spring Cloud Config for externalized configuration and supports:
- Database connection via AWS Secrets Manager
- Kafka cluster configuration
- Firebase service account credentials

## Development

```bash
# Build the application
./gradlew build

# Run tests
./gradlew test

# Apply code formatting
./gradlew spotlessApply

# Run the application
java -jar app/build/libs/app-1.0.0.jar
```

## Deployment

- Deployed via Jenkins CI/CD pipeline
- Containerized using Docker
- Deployed to AWS ECS using Copilot
