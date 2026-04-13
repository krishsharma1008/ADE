# Accounting Service

BukuWarung's core business and transaction management service handling ledgers, businesses, and financial records.

## GitHub Repository

https://github.com/bukuwarung/accounting-service

## Description

The Accounting Service is one of BukuWarung's core services responsible for managing business entities, transactions, ledgers, and financial records. It serves as the central source of truth for business data and transaction history across the platform. The service also handles B2B supplier integrations.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 8 |
| Framework | Spring Boot 2.4.6 |
| Build Tool | Maven |
| Database | PostgreSQL |
| ORM | Hibernate 5.4, Spring Data JPA |
| Migrations | Flyway |
| API Documentation | SpringDoc OpenAPI |
| Cloud | AWS (S3, Secrets Manager) |
| Analytics | Google BigQuery, Amplitude |
| File Processing | Apache POI, OpenCSV |

## Project Structure

```
accounting-service/
├── ac-commons/        # Shared DTOs, utilities, and constants
├── ac-dao/            # Data Access Objects and repositories
├── ac-service/        # Business logic and services
├── ac-web/            # REST API controllers
├── ac-outbound/       # External service integrations
├── ac-utility/        # Utility functions and helpers
├── accounting-service/# Application entry point
├── jacoco-report/     # Test coverage reporting
├── docs/              # Documentation and diagrams
└── documentation/     # Additional documentation
```

## Key Features / Responsibilities

- **Business Management**:
  - Create and manage business entities
  - Business profile and settings
  - Multi-location business support

- **Transaction Management**:
  - Record all financial transactions
  - Transaction categorization
  - Transaction search and filtering

- **Ledger Management**:
  - Double-entry bookkeeping
  - Balance tracking
  - Financial reporting

- **B2B Supplier Integration**:
  - Supplier management
  - Purchase order processing
  - Supplier transaction records

- **Data Export/Import**:
  - Excel/CSV report generation
  - Bulk data import
  - BigQuery integration for analytics

- **User-Business Association**:
  - Link users to businesses
  - Role-based business access

## API Routes (via app-gateway)

| Route Pattern | Description |
|---------------|-------------|
| `/ac/**` | Core accounting service endpoints |
| `/b2b/supplier/**` | B2B supplier management endpoints |

## Dependencies / Integrations

### Internal Services
- **multi-tenant-auth**: User authentication and authorization
- **payments**: Payment transaction synchronization
- **notification**: Transaction and business notifications
- **janus**: KYC status for business verification

### External Services
- **Firebase**: Push notifications, real-time updates
- **Google BigQuery**: Analytics and reporting
- **AWS S3**: Document and report storage
- **AWS Secrets Manager**: Credential management
- **Amplitude**: Product analytics

## Local Development

### Prerequisites
- Java 8
- Maven
- PostgreSQL

### Build

```bash
# Build the project
mvn clean install

# Or with Docker
cd docker
./build
./run
```

### Run

```bash
# Run with Maven
mvn spring-boot:run

# Or run the JAR directly
java -jar target/accounting-service.jar
```

The application runs on port 9080 by default.

## Code Style

```bash
# Check style (via Spotless)
mvn spotless:check

# Apply style
mvn spotless:apply
```

## Testing

```bash
# Run tests
mvn test

# Run with coverage report
mvn test jacoco:report
```

Coverage report is generated in `jacoco-report/target/site/jacoco-aggregate/`.

## API Documentation

When running locally:
- Swagger UI: http://localhost:9080/swagger-ui.html
- API Base Path: http://localhost:9080/api/

## Database Schema

The service manages core business entities including:
- Businesses
- Users (business associations)
- Transactions
- Ledger entries
- Categories
- Suppliers

![Database Schema](docs/images/accounting-db-schema.png)

Schema diagram: https://app.sqldbm.com/PostgreSQL/Edit/p128650/

## Architecture

```
┌─────────────────────────────────────────┐
│            ac-web (Controllers)          │
├─────────────────────────────────────────┤
│           ac-service (Business Logic)    │
├─────────────────────────────────────────┤
│  ┌─────────────┐  ┌──────────────────┐  │
│  │   ac-dao    │  │   ac-outbound    │  │
│  │ (Database)  │  │(External Services)│  │
│  └─────────────┘  └──────────────────┘  │
├─────────────────────────────────────────┤
│           ac-commons (Shared)            │
│           ac-utility (Helpers)           │
└─────────────────────────────────────────┘
```

## Logging

Logs are written to `/var/log/accounting-service` (may require system permissions).

## Module Dependencies

```
accounting-service (main app)
    ├── ac-web
    │   └── ac-service
    │       ├── ac-dao
    │       │   └── ac-commons
    │       └── ac-outbound
    │           └── ac-commons
    └── ac-utility
```

## Diagrams

Comprehensive architecture and flow diagrams are available in the [diagrams/](./diagrams/) directory:

- EDC Order Flow & Flow Types
- EDC Management Architecture
- Terminal Lifecycle States
- Transaction Processing Flow
- Service Architecture
- Module Dependencies
- Data Flow & Integration Points
- Database Schema

## Feature Documentation

Detailed documentation for major feature modules:

| Feature | Directory | Description |
|---------|-----------|-------------|
| [EDC Order](./edc-order/) | `edc-order/` | EDC terminal order management (organic, partnership, EZA flows) |
| [EDC Management](./edc-management/) | `edc-management/` | Terminal lifecycle and configuration management |
| [EDC Device Mapping](./edc-device-mapping/) | `edc-device-mapping/` | Device-to-terminal mapping and registry |
| [EDC Catalog](./edc-catalog/) | `edc-catalog/` | Product catalog for EDC devices and plans |
| [Accounting Transactions](./accounting-transactions/) | `accounting-transactions/` | Core financial transaction management |

## Additional Modules (Not Separately Documented)

Beyond the main documented features, the accounting-service includes these additional modules:

### EDC Related
| Module | Location | Description |
|--------|----------|-------------|
| **EDC Cart** | `ac-service/.../edc/cart/` | Shopping cart for EDC orders |
| **EDC Payments** | `ac-service/.../edc/payments/` | Payment processing for EDC orders |
| **EDC Account** | `ac-service/.../edc/account/` | EDC-specific account management |
| **EDC Location** | `ac-service/.../edc/location/` | Location services for EDC |
| **EDC Referral** | `ac-service/.../edc/referral/` | Referral code management |

### Business & Customer
| Module | Location | Description |
|--------|----------|-------------|
| **Business Service** | `BusinessService.java` | Business entity CRUD operations |
| **Customer Management** | `CustomerManagementService.java` | Customer data management |
| **Customer Transaction** | `CustomerTransactionService.java` | Customer-specific transactions |

### Integration & Sync
| Module | Location | Description |
|--------|----------|-------------|
| **Firestore Sync** | `FirestoreSyncService.java` | Real-time Firebase synchronization |
| **Manual Sync** | `ManualSyncService.java` | On-demand data synchronization |
| **Dracula Events** | `DraculaEventService.java` | Kafka event publishing to Dracula |
| **MX Events** | `MxEventService.java` | MX (Merchant Experience) events |

### B2B & Supplier
| Module | Location | Description |
|--------|----------|-------------|
| **Supplier Service** | `ac-service/.../supplier/` | B2B supplier management |
| **Tokoko Integration** | `TkkService.java` | Tokoko e-commerce integration |

### Other Services
| Module | Location | Description |
|--------|----------|-------------|
| **Inventory Service** | `InventoryService.java` | Inventory/stock management |
| **Lending Service** | `LendingService.java` | Loan integration |
| **Notification Service** | `SendNotificationService.java` | Notification dispatch |
| **Migration Service** | `ac-service/.../migration/` | Data migration utilities |

## EDC Order Flow Types

The system supports multiple EDC order acquisition channels:

| Flow Type | Enum | Description |
|-----------|------|-------------|
| Organic/App | `BUKUWARUNG` | Self-service orders from BukuWarung app |
| Partnership | `PARTNERSHIP` | Partner-driven orders |
| EZA | `EZA` | EZA partner channel |
| TikTok | `TIKTOK` | TikTok Shop integration |
| Web | `WEB` | Web portal orders |

## Key Enums Reference

| Enum | Purpose |
|------|---------|
| `OrderFlowType` | Order acquisition channel |
| `ActivateRequestType` | Partnership vs non-partnership activation |
| `TransactionType` | Transaction categorization |
| `FormStatus` | EDC order form processing status |
| `EdcDeliveryStatus` | Delivery tracking status |
| `EdcOrderPaymentStatus` | Payment processing status |
| `EdcVendor` | Supported EDC vendors |
| `EdcDevicePlan` | Device plan types (RENT/BUY) |
