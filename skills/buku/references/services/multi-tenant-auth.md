# Multi-Tenant Auth Service

BukuWarung's authentication and authorization service supporting multi-tenant architecture.

## GitHub Repository

https://github.com/bukuwarung/multi-tenant-auth

## Description

The Multi-Tenant Auth service handles user authentication, authorization, and session management across BukuWarung's platform. It supports JWT-based authentication, multi-tenant isolation, OTP verification, and integrates with various identity providers. The service manages user accounts, permissions, and security policies.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 21 |
| Framework | Spring Boot 3.3.10 |
| Build Tool | Gradle |
| Database | PostgreSQL |
| Caching | Redis (Redisson) |
| ORM | Hibernate 6.6, Spring Data JPA |
| Migrations | Flyway |
| Auth | JWT (java-jwt), Spring Security |
| Messaging | Kafka |
| API Documentation | SpringDoc OpenAPI |

## Project Structure

```
multi-tenant-auth/
├── src/
│   └── main/java/com/bukuwarung/
│       ├── controller/    # REST API controllers
│       ├── service/       # Business logic services
│       ├── repository/    # Data access layer
│       ├── entity/        # JPA entities
│       ├── dto/           # Data transfer objects
│       ├── security/      # Security configurations
│       ├── sms/           # SMS/OTP providers
│       └── exception/     # Custom exceptions
├── docs/                  # Documentation and diagrams
├── plans/                 # Development plans
└── deployments/           # Kubernetes configurations
```

## Key Features / Responsibilities

- **User Authentication**: Login, logout, session management
- **JWT Token Management**: Token generation, validation, refresh
- **Multi-tenant Support**: Tenant isolation and context management
- **OTP Verification**: SMS-based OTP for login and verification
- **Password Management**: Password reset, change, policies
- **Role-based Access Control**: User roles and permissions
- **Device Management**: Track and manage user devices
- **Rate Limiting**: Protect against brute force attacks
- **Captcha Verification**: Additional security layer

## API Routes (via app-gateway)

| Route Pattern | Description |
|---------------|-------------|
| `/api/v1/auth/**` | Authentication API v1 |
| `/api/v2/auth/**` | Authentication API v2 |
| `/api/v3/auth/**` | Authentication API v3 (latest) |

## Dependencies / Integrations

### Internal Services
- **notification**: Sending OTP and verification messages
- **accounting-service**: User profile data synchronization

### External Services
- **Twilio**: SMS delivery for OTP
- **MessageBird**: Alternative SMS provider
- **Firebase**: Push notification tokens, FCM
- **Redis**: Session caching, rate limiting
- **Kafka**: Event publishing for user actions
- **AWS Secrets Manager**: Credential management
- **AWS SSM**: Parameter store for configuration

## Local Development

### Prerequisites
- Java 21
- PostgreSQL
- Redis

### Setup Database

```bash
# Run setup script
./setup-local-db.sh
```

### Build and Run

```bash
# Build the project
./gradlew clean build

# Run the application
./gradlew bootRun

# Or use the run script
./run-app.sh
```

## Code Style

```bash
# Check formatting
./gradlew spotlessCheck

# Apply formatting
./gradlew spotlessApply
```

## Testing

```bash
# Run tests
./gradlew test

# Run with coverage
./gradlew test jacocoTestReport
```

## API Documentation

When running locally:
- Swagger UI: http://localhost:9084/swagger-ui.html
- API Base Path: http://localhost:9084/

## Database Schema

The service manages these primary entities:
- Users
- Tenants
- Roles and Permissions
- Sessions
- OTP Records
- Device Registrations

![Database Schema](docs/images/user-db-schema.png)
