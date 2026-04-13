# Data Analytics Service (data-analytics)

## Description

The Data Analytics Service (also known as Fintech Product Service) is a Spring Boot application that provides analytics and data processing capabilities for BukuWarung's platform. It follows a Hexagonal Architecture (Ports & Adapters pattern) for clean separation of concerns and testability.

## GitHub Repository

https://github.com/bukuwarung/data-analytics

## Tech Stack

- **Language**: Java 8
- **Framework**: Spring Boot 2.4.3
- **Build Tool**: Maven
- **Database**: PostgreSQL
- **Cloud Platform**: Google Cloud (BigQuery)
- **Code Style**: Google Java Format (Spotless)

## Key Features/Responsibilities

- Data analytics and reporting
- Integration with Google Cloud services
- Event publishing and data streaming
- API endpoints for analytics data retrieval
- Multi-container local development support
- Fintech product analytics processing

## API Routes

- **Base Path**: `/data-analytics/**`
- REST APIs for analytics data access

## Project Structure

The service follows Hexagonal Architecture:

```
api/           # Inbound adapters (REST controllers)
client/        # Outbound adapters (external API clients)
  - MOE client
  - Payment service client
common/        # Shared utilities and configurations
core/          # Domain logic and ports
  - Use cases
  - Domain models
  - Port interfaces
persistence/   # Database adapters
publisher/     # Event publishing adapters
server/        # Application entry point
```

## Hexagonal Architecture

The project implements the Ports & Adapters pattern:
- **Ports**: Interfaces defining the boundaries
- **Adapters**: Implementations connecting to external systems
- **Core**: Pure business logic independent of frameworks

Reference: [Hexagonal Architecture with Java and Spring](https://reflectoring.io/spring-hexagonal/)

## Dependencies/Integrations

- **PostgreSQL**: Primary database
- **Google Cloud BigQuery**: Big data analytics queries
- **Google Cloud Libraries**: Cloud service integrations
- **Payment Service**: Integration with BukuWarung payment services
- **MOE (MoEngage)**: Marketing automation integration
- **Logstash**: Log aggregation and forwarding

## Development Guidelines

1. Merge to mainline only via PR (hotfix is exception)
2. A PR is for one task - use squash merge
3. Configuration should never be hardcoded - use `application.yml` with environment variables
4. Update `docker-compose.local.yml` and Copilot `manifest.yml` for new env variables

## Local Development

### Build

```bash
mvn spotless:apply clean package
```

### Run with Docker

```bash
docker-compose --file docker-compose.local.yml up --build
```

### Multi-Container Setup

For running with dependencies (Postgres, Redis, etc.):

1. Create network:
```bash
docker network create bw
```

2. Run PostgreSQL:
```bash
docker run --detach \
    --name postgres \
    --volume ${HOME}/DockerPG/finpro:/var/lib/postgresql/data \
    --publish 5432:5432 \
    --env POSTGRES_PASSWORD=SuperSecret \
    --env POSTGRES_USER=finpro \
    --network bw \
    postgres:12
```

3. Set environment variables:
```bash
export FINPRO_DB_DSN_KEY='jdbc:postgresql://postgres:5432/finpro_development?user=finpro&password=SuperSecret'
export DB_SCHEMA=development
```

## Documentation

- [System Design](https://bukuwarung.atlassian.net/wiki/spaces/tech/pages/451150149/Fintech+Product+System+Design)

## Deployment

- Deployed via Jenkins CI/CD pipeline
- Containerized using Docker
- Deployed to AWS ECS using Copilot
