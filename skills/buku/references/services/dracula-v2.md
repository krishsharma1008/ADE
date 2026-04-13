# Dracula V2

Kafka data consumer service - processes and routes messages from various Kafka topics for data pipeline and event processing.

## Repository

- **GitHub**: https://github.com/bukuwarung/dracula-v2

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 21 |
| Framework | Spring Boot 3.3.5 |
| Build Tool | Gradle |
| Message Broker | Apache Kafka (Spring Kafka) |
| Cache | Redis (Redisson) |
| Monitoring | Datadog (StatsD) |
| Architecture | Consumer-Processor-Sink Pattern |

## Key Features / Responsibilities

- Kafka message consumption from multiple topics
- Data transformation and processing
- Message routing to various sinks (Redis, external services)
- Real-time event processing
- Metrics and monitoring via Datadog
- Data pipeline orchestration

## Project Structure

```
dracula-v2/
|-- src/main/java/com/bukuwarung/dracula/
|   |-- Application.java     # Main application entry point
|   |-- config/              # Configuration classes
|   |-- consumer/            # Kafka consumer implementations
|   |-- model/               # Data models and DTOs
|   |-- monitoring/          # Metrics and monitoring
|   |-- processor/           # Message processors
|   |-- sink/                # Output sinks (Redis, etc.)
|-- deployments/             # Kubernetes deployment configs
```

## API Routes

| Route Pattern | Description |
|---------------|-------------|
| `/dracula-v2/**` | Health check and operational endpoints |

Note: This is primarily a consumer service, so most operations are triggered by Kafka messages rather than HTTP requests.

## Dependencies / Integrations

### Internal Services
- **Kafka Topics**: Consumes events from various BukuWarung services
- **Redis**: Data caching and state management
- Publishes processed data to downstream services

### External Dependencies
- **Apache Kafka**: Message broker
- **Redis**: Via Redisson Spring Boot Starter
- **Datadog**: APM and metrics (dd-java-agent)

### Key Libraries
- **Spring Kafka**: Kafka consumer framework
- **Spring Kafka Test**: Testing utilities
- **Redisson**: Redis client
- **java-dogstatsd-client**: Datadog metrics

## Development

### Prerequisites
- Java 21
- Gradle
- Kafka
- Redis

### Build & Run
```bash
# Build the project
./gradlew clean build

# Run tests
./gradlew test
```

### Code Quality
```bash
# Format code
./gradlew spotlessApply

# Run with SonarQube
./gradlew sonarqube
```

### Testing
```bash
# Run unit tests
./gradlew test

# Generate coverage report
./gradlew jacocoTestReport
```

## Architecture Notes

### Consumer-Processor-Sink Pattern
1. **Consumer**: Listens to Kafka topics and receives messages
2. **Processor**: Transforms and validates incoming data
3. **Sink**: Routes processed data to appropriate destinations (Redis, external APIs)

### Monitoring
- Integrated with Datadog for APM
- Uses `java-dogstatsd-client` for custom metrics
- JaCoCo for code coverage reporting

### Production Deployment
- Runs with Datadog Java agent (`dd-java-agent-1.45.2.jar`)
- Kubernetes deployment configurations in `deployments/`
