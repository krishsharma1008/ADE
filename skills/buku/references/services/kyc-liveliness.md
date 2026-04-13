# KYC Liveliness

## Description

KYC Liveliness is a microservice that integrates with VIDA (Verihubs Identity Authentication) for passive liveliness detection. It handles webhook callbacks from VIDA to process the results of liveliness verification checks, which are part of the KYC (Know Your Customer) verification flow for user onboarding.

## GitHub Repository

[https://github.com/bukuwarung/kyc-liveliness](https://github.com/bukuwarung/kyc-liveliness)

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 11 |
| Framework | Spring Boot 2.6.3 |
| Build Tool | Gradle |
| Logging | Logback with Logstash encoder |
| Documentation | SpringDoc OpenAPI / Swagger |

## Key Features / Responsibilities

- **VIDA Integration**: Connect to VIDA's passive liveliness detection service
- **Webhook Handler**: Process status callbacks from VIDA
- **Liveliness Verification**: Validate user identity through passive liveliness checks
- **KYC Support**: Part of the broader KYC verification ecosystem
- **Resilient Operations**: Built with Resilience4j for fault tolerance
- **Structured Logging**: Uses BW Common Logger for consistent logging

## API Routes (via App Gateway)

| Route Pattern | Description |
|---------------|-------------|
| `/kycliveliness/webhooks/vida/status` | VIDA liveliness status webhook endpoint |

## Project Structure

```
kyc-liveliness/
├── src/main/java/com/bukuwarung/kycliveliness/
│   ├── config/        # Configuration classes
│   ├── controller/    # REST API controllers (webhook handlers)
│   ├── exception/     # Custom exception handlers
│   ├── model/         # Request/response models
│   └── service/       # Business logic layer
└── deployments/       # Deployment configurations
```

## Dependencies / Integrations

### External Services
- **VIDA (Verihubs)**: Passive liveliness detection provider

### Internal Services
- **App Gateway**: Routes webhook traffic through `/kycliveliness/webhooks/vida/status`
- **KYC Service**: Likely integrates with main KYC service for verification flow

### Key Libraries
- Spring Boot Web for REST APIs
- Resilience4j for circuit breaker and retry patterns
- BW Common Logger for structured logging
- Logstash Logback Encoder for JSON logging
- Spring Validation for request validation

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

## Webhook Flow

1. User initiates liveliness check in the mobile app
2. App redirects to VIDA for passive liveliness verification
3. VIDA processes the verification
4. VIDA sends status callback to `/kycliveliness/webhooks/vida/status`
5. Service processes the result and updates user's KYC status
