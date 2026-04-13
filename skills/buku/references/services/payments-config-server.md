# Payments Config Server (payments-config-server)

## Description

The Payments Config Server is a Spring Cloud Config Server that provides centralized configuration management for BukuWarung's payment services. It enables dynamic configuration updates, environment-specific settings, and real-time configuration refresh without service restarts.

## GitHub Repository

https://github.com/bukuwarung/payments-config-server

## Tech Stack

- **Language**: Java 11
- **Framework**: Spring Boot 2.6.6
- **Build Tool**: Maven
- **Cloud Framework**: Spring Cloud 2021.0.0
- **Config Server**: Spring Cloud Config Server
- **Messaging**: Kafka (Spring Cloud Bus)
- **Database**: PostgreSQL
- **Code Style**: Google Java Format (Spotless)

## Key Features/Responsibilities

- Centralized configuration management for payment services
- Dynamic configuration updates via Spring Cloud Bus
- Environment-specific configuration profiles
- Configuration versioning and history
- Kafka-based configuration refresh notifications
- Payment method configuration management
- Database-backed configuration storage

## API Routes

- **Base Path**: `/payments-config-server/**`
- **Swagger Documentation**: `https://api-staging-v1.bukuwarung.com/payments-config-server/docs`

## Project Structure

```
app/           # Main application module
  - Spring Cloud Config Server bootstrap
  - Application entry point
adapters/
  api/         # REST API controllers
  persistence/ # Database repositories
  publisher/   # Kafka message publishers
common/        # Shared utilities and DTOs
core/          # Business logic and domain services
```

## Spring Cloud Config Features

- **Config Server**: Serves configuration to client applications
- **Config Monitor**: Monitors for configuration changes
- **Cloud Bus Kafka**: Propagates configuration changes across services

## Dependencies/Integrations

- **PostgreSQL**: Database-backed configuration storage
- **Kafka**: Message broker for configuration refresh events
- **Spring Cloud Bus**: Configuration change propagation
- **Spring Cloud Config Monitor**: Change detection and notification
- **Prometheus (Micrometer)**: Metrics collection
- **OkHttp**: HTTP client for webhook notifications

## Client Integration

Services that use this config server include:
- Payment services
- Rule Engine
- Other payment-related microservices

Client services connect using:
```yaml
spring:
  cloud:
    config:
      uri: http://payments-config-server
```

## TODO Items (from repository)

1. Add security layer for authentication
2. Support for multiple property files belonging to a client service
3. Auto refresh for application properties saved in db
4. Write test cases and push coverage to 100%
5. Rollback the update config transaction for payment method configuration if refresh API call fails

## Development

```bash
# Build the application
./mvnw clean package

# Apply code formatting
./mvnw spotless:apply

# Run the application
java -jar app/target/app-1.0.0.jar
```

## Deployment

- Deployed via Jenkins CI/CD pipeline
- Containerized using Docker
- Deployed to AWS ECS using Copilot
