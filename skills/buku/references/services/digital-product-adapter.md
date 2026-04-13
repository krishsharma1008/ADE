# Digital Product Adapter (digital-product-adapter)

## Description

The Digital Product Adapter is a Spring Boot service that acts as an aggregator for PPOB (Payment Point Online Bank) external providers. It provides a unified interface for integrating with various digital product providers, enabling BukuWarung merchants to sell digital products such as phone credits, data packages, electricity tokens, and other bill payments.

## GitHub Repository

https://github.com/bukuwarung/digital-product-adapter

## Tech Stack

- **Language**: Java 11
- **Framework**: Spring Boot 2.5.6
- **Build Tool**: Gradle
- **Database**: PostgreSQL
- **ORM**: Spring Data JPA, Hibernate
- **Migration**: Flyway 7.9.1
- **HTTP Client**: OkHttp 3.10.0, Spring Cloud OpenFeign
- **Circuit Breaker**: Resilience4j
- **Code Style**: Google Java Format (Spotless 7.2.1)

## Key Features/Responsibilities

- External provider aggregation for digital products
- Unified API interface for multiple PPOB providers
- Product catalog management (phone credits, data packages, electricity, etc.)
- Transaction processing with external providers
- Retry and circuit breaker patterns for resilient integrations
- JWT-based authentication with external providers
- Cryptographic operations for secure provider communication (BouncyCastle)

## API Routes

- **Base Path**: `/digital-products/external/**`
- REST APIs documented via SpringDoc OpenAPI

## Project Structure

```
app/           # Main application module
  - Controllers and API endpoints
  - Spring Security configuration
  - Kafka message consumers
common/        # Shared utilities and common code
core/          # Business logic and domain services
  - Product information services
  - Transaction processing logic
persistence/   # Database entities, repositories, and migrations
  - Flyway migrations
  - JPA repositories
provider/      # External provider integrations
  - Provider-specific adapters
  - HTTP client configurations
  - JWT token handling
  - Cryptographic utilities
plans/         # Implementation plans and documentation
```

## Dependencies/Integrations

- **PostgreSQL**: Primary database with AWS Secrets Manager JDBC integration
- **External PPOB Providers**: Various digital product providers via REST APIs
- **Spring Cloud OpenFeign**: Declarative HTTP client for provider integrations
- **Resilience4j**: Circuit breaker for fault-tolerant external calls
- **Kafka**: Event streaming for transaction processing
- **Firebase Admin**: Authentication and verification
- **AWS SDK**: Cloud service integrations
- **BouncyCastle**: Cryptographic operations for secure communications
- **Guava**: Utility library for common operations

## External Provider Integration

The service provides:
- Unified adapter pattern for multiple providers
- Request/response transformation
- Error handling and retry logic
- Transaction state management
- Provider health monitoring

## Development

```bash
# Build the application
make build

# Or using Gradle directly
./gradlew build

# Apply code formatting
./gradlew spotlessApply

# Run the application
java -jar app/build/libs/app-1.0.jar
```

## Deployment

- Deployed via Jenkins CI/CD pipeline
- Containerized using Docker
- Deployed to AWS ECS using Copilot
