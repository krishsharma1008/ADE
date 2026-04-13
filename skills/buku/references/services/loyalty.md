# Loyalty Rewards Service (loyalty)

## Description

The Loyalty Rewards Service is a comprehensive Spring Boot application that manages BukuWarung's rewards and loyalty program. It handles user points, referral campaigns, leaderboards, streaks, and reward distribution to incentivize user engagement and growth.

## GitHub Repository

https://github.com/bukuwarung/loyalty

## Tech Stack

- **Language**: Java 8
- **Framework**: Spring Boot 2.4.6
- **Build Tool**: Maven
- **Database**: PostgreSQL
- **Caching**: Redis (Redisson)
- **Messaging**: Kafka (Spring Kafka 2.7.2)
- **Big Data**: Google BigQuery
- **Rule Processing**: MVEL expression language
- **Code Style**: Google Java Format (Spotless)

## Key Features/Responsibilities

- User loyalty points management
- Referral campaigns and tracking
- Leaderboard systems
- Streak-based rewards
- Rule-based reward processing using MVEL
- Kafka event consumption for user activity tracking
- Scheduled task execution with ShedLock for distributed locking
- Redis caching for performance optimization
- BigQuery integration for analytics

## API Routes

- **Base Path**: `/loyalty/**`
- **Local Base URL**: `http://localhost:7070/api/`
- REST APIs documented via SpringDoc OpenAPI

## Project Structure

```
loyalty-commons/    # Shared DTOs and utilities
loyalty-dao/        # Data access layer (JPA repositories)
loyalty-service/    # Core business logic
loyalty-worker/     # Kafka consumers and background workers
loyalty-web/        # REST API controllers
loyalty-outbound/   # External service integrations
loyalty-utility/    # Utility functions
jacoco-report/      # Code coverage reports
```

## Dependencies/Integrations

- **PostgreSQL**: Primary database with AWS Secrets Manager JDBC integration
- **Kafka**: Event streaming for user activity ingestion
- **Redis (Redisson)**: Distributed caching and session management
- **Google BigQuery**: Analytics data querying
- **Firebase Admin**: User authentication and push notifications
- **AWS S3**: File storage for rewards/assets
- **ShedLock**: Distributed lock for scheduled tasks

## Kafka Integration

The service consumes events for:
- User transactions
- App activity
- Referral actions
- Campaign triggers

See [Kafka Event Contracts](https://bukuwarung.atlassian.net/wiki/spaces/tech/pages/972062957/Loyalty+Kafka+Event+Contracts)

## Configuration

Uses Jasypt for encrypted properties. Set the following environment variable:

```bash
export JASYPT_ENCRYPTOR_PASSWORD=<PROPS_PWD>
```

## Development

### Build and Run

```bash
# Using Docker
cd docker
build
sudo run

# Using Maven
mvn clean install -DskipTests
java -Djasypt.encryptor.password=<PROPS_PWD> -jar loyalty-web/target/loyalty-web-${version}-fat.jar

# Or using Spring Boot Maven plugin
mvn -Djasypt.encryptor.password=<PROPS_PWD> spring-boot:run
```

## Documentation

- [System Design (WIP)](https://bukuwarung.atlassian.net/wiki/spaces/tech/pages/979140956/WIP+Loyalty+System)
- [API Contracts](https://bukuwarung.atlassian.net/wiki/spaces/tech/pages/964853976/Loyalty+API+contracts)
- [Kafka Event Contracts](https://bukuwarung.atlassian.net/wiki/spaces/tech/pages/972062957/Loyalty+Kafka+Event+Contracts)
- [AWS Deployment](https://bukuwarung.atlassian.net/wiki/spaces/tech/pages/990609599/Loyalty+AWS+Deployments)

## Deployment

- Deployed via Jenkins CI/CD pipeline
- Containerized using Docker
- Deployed to AWS ECS using Copilot
- Uses Datadog Java Agent for APM (dd-java-agent-1.35.2.jar)
