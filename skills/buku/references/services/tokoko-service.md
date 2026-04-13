# Tokoko Service

## Description

Tokoko Service is the backend service for Tokoko, BukuWarung's e-commerce platform. It powers the online store functionality that allows merchants to create digital storefronts, manage products, process orders, and handle shipping through integration with Shipper logistics. The service also supports B2B invoicing functionality.

## GitHub Repository

[https://github.com/bukuwarung/tokoko-service](https://github.com/bukuwarung/tokoko-service)

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 8+ |
| Framework | Spring Boot 2.4.6 |
| Build Tool | Gradle |
| Database | PostgreSQL |
| Search | Elasticsearch |
| Documentation | SpringDoc OpenAPI / Swagger |

## Key Features / Responsibilities

- **Store Management**: Create and manage digital storefronts for merchants
- **Product Catalog**: Product listing, inventory management, and catalog operations
- **Order Processing**: Handle customer orders and order lifecycle
- **Shipping Integration**: Integration with Shipper logistics platform
- **B2B Invoicing**: Support for B2B invoice generation and management
- **Buyer Web Portal**: Web interface for customers to browse and purchase
- **Push Notifications**: Firebase integration for order notifications
- **Search**: Elasticsearch for product and store search

## API Routes (via App Gateway)

| Route Pattern | Description |
|---------------|-------------|
| `/tokoko/shipper/**` | Shipper logistics integration endpoints |
| `/b2b/invoice/**` | B2B invoicing operations |

## Project Structure

```
tokoko-service/
├── tokoko-commons/     # Shared utilities and models
├── tokoko-dao/         # Data access layer
├── tokoko-outbound/    # External service integrations
├── tokoko-service/     # Core service module
├── tokoko-utility/     # Utility functions
├── tokoko-web/         # Web API controllers
└── tokowa-buyerweb/    # Buyer-facing web application
```

## Dependencies / Integrations

### External Services
- **Shipper**: Logistics and shipping provider
- **Firebase**: Push notifications for order updates
- **Elasticsearch**: Product and store search

### Internal Services
- **App Gateway**: Routes traffic through `/tokoko/**` and `/b2b/invoice/**`
- **AWS Secrets Manager**: Secure database credential management
- **Payments Service**: May integrate for payment processing

### Key Libraries
- Spring Data Elasticsearch
- Spring Data JPA
- MapStruct for object mapping
- OkHttp for HTTP client operations
- Jackson for JSON processing
- Guava for collections and utilities
- Lombok for boilerplate reduction
- Firebase Admin SDK

## Development

### Requirements
- Java 8 or above
- Gradle (latest version)
- PostgreSQL
- Elasticsearch
- IDE (Eclipse/IntelliJ recommended)

### Setup

1. Clone the repository
2. Set `JAVA_HOME` for your Java installation
3. Import as Gradle project
4. Install Project Lombok plugin
5. Set VM arguments: `-Dspring.profiles.active=local`

### Build
```bash
./gradlew build
```

### Run
```bash
./gradlew bootRun
```

Access the application at: http://localhost:5000/mkstore

### Code Quality
SonarQube integration is configured for code quality analysis.
