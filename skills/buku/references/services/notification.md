# Notification Service

BukuWarung's centralized notification service for handling multi-channel messaging across the platform.

## GitHub Repository

https://github.com/bukuwarung/notification

## Description

The Notification service handles sending notifications through multiple delivery channels including SMS, WhatsApp, Email, Push Notifications, and Slack. It supports various providers and uses both API-based and event-based integration approaches.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 8+ |
| Framework | Spring Boot 2.3.3 |
| Build Tool | Gradle |
| Database | PostgreSQL (via Spring Data JPA) |
| Message Provider | MessageBird API |
| Cloud | AWS (Secrets Manager) |

## Project Structure

```
notification/
├── adapters/
│   ├── api/          # REST API adapters
│   ├── persistence/  # Database adapters
│   └── provider/     # External provider adapters (SMS, WA, Email, etc.)
├── common/           # Shared utilities and constants
├── core/             # Business logic and domain
├── server/           # Application entry point
└── worker/           # Background job processing
```

## Key Features / Responsibilities

- **Multi-channel delivery**: SMS, WhatsApp, Email, Push Notifications, Slack
- **Multiple provider support**: Twilio, Wavecell, MessageBird, Firebase, AWS SES
- **API-based integration**: RESTful endpoints for sending notifications
- **Event-based integration**: Async processing via worker for high-throughput scenarios
- **Template management**: Support for notification templates
- **Delivery tracking**: Track notification delivery status

## API Routes (via app-gateway)

| Route Pattern | Description |
|---------------|-------------|
| `/notification/**` | Notification service endpoints |
| `/api/notification/**` | API v2 notification endpoints |

## Dependencies / Integrations

### Internal Services
- **accounting-service**: Receives transaction events for notifications
- **payments**: Payment completion notifications
- **multi-tenant-auth**: User authentication for API access
- **finpro**: Digital product transaction notifications

### External Providers
- **MessageBird**: SMS and WhatsApp messaging
- **Twilio**: SMS messaging
- **Wavecell**: SMS messaging
- **Firebase**: Push notifications
- **AWS SES**: Email delivery
- **Slack**: Internal team notifications

## Local Development

```bash
# Start dependencies
docker-compose -f docker-compose.local.yml up -d

# Build the project
./gradlew build

# Run the application
./gradlew :server:bootRun
```

## Configuration

Key environment variables:
- `DB_HOST`, `DB_PORT`, `DB_NAME` - Database connection
- `MESSAGEBIRD_API_KEY` - MessageBird provider credentials
- `AWS_REGION` - AWS region for Secrets Manager
