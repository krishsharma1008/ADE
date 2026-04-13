# EDC Adapter

EDC (Electronic Data Capture) terminal middleware adapter - a Java-based payment processing service that acts as middleware between EDC terminals and backend financial systems (BBW bank servers). All financial and network management operations communicate via ISO 8583 messages over TCP connections.

## Repository

- **GitHub**: https://github.com/bukuwarung/edc-adapter

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Java 17 |
| Framework | Spring Boot 3.2.2 |
| Build Tool | Gradle (multi-module) |
| Database | PostgreSQL (with Flyway 10.7.1 migrations) |
| Message Broker | Kafka (Spring Cloud Stream) |
| ISO 8583 | jreactive8583, j8583 |
| Architecture | Hexagonal (Clean Architecture) |
| Caching | Caffeine (in-memory) |
| Resilience | Resilience4j (circuit breaker) |

## High-Level Architecture

```
EDC Terminal ──► edc-adapter ──► BBW Bank Server (ISO 8583 over TCP)
                    │
                    ├── DC (Primary Data Center)
                    └── DRC (Disaster Recovery Center)
```

All features follow a layered architecture: **Controller → Service → Provider → BBWClient** with clear port/adapter boundaries (hexagonal architecture).

### Cross-Cutting Concerns

- **DC/DRC Load Balancing**: Dual data center routing with configurable strategies (LOAD_BALANCE, DC_ONLY, DRC_ONLY, FAILOVER_TO_DRC, FAILOVER_TO_DC) and health monitoring every 30 seconds.
- **ARPC Validation**: Financial transactions require ARPC chip card validation with confirm/reversal paths.
- **Correlation Key**: Request-response matching uses `terminalId + responseMTI + STAN` stored in a `BBWConcurrentMap`.
- **Transaction Routing Audit**: All financial transactions are audited in `transaction_routing_audit` for DC/DRC observability.
- **Terminal Config Validation**: Every transaction validates EDC user authorization (buku-origin header, serial number match) against terminal config. Mismatch throws BW17 error (HTTP 422).

## Features Overview

### 1. Transfer (Fund Transfer) [[source](https://github.com/bukuwarung/edc-adapter/blob/main/docs/features/transfer.md)]

Enables fund transfers between bank accounts via EDC terminals using a **two-phase flow**.

| Phase | Endpoint | Purpose |
|-------|----------|---------|
| Inquiry | `POST /transfer/inquiry/{accountId}` | Validate destination account, get beneficiary name |
| Posting | `POST /transfer/posting/{account_id}` | Execute the fund transfer |
| Confirm | `POST /transfer/posting/confirm/{account_id}` | Confirm ARPC chip validation |
| Reversal | `POST /transactions/reversal/{account_id}` | Reverse on ARPC failure/timeout |

**Flow**: Inquiry validates destination → ISO 8583 to BBW (processing code `201000` for savings) → BBW returns beneficiary name → Posting executes transfer (processing code `050000`) → ARPC validation on chip card → confirm or reversal. Timeouts trigger async reversal with up to 3 retries. Pending transactions (RCZ3/RCZ4 codes) are queued for periodic check-status polling.

**Integrations**: BBW server (ISO 8583), Kafka (success events), Amplitude/CleverTap (analytics), push notifications.

### 2. Cash Withdrawal [[source](https://github.com/bukuwarung/edc-adapter/blob/main/docs/features/cash-withdrawal.md)]

Enables cardholders to withdraw cash from bank accounts through EDC terminals at merchant locations. Functionally similar to Transfer but with processing code `BW03`.

| Phase | Endpoint | Purpose |
|-------|----------|---------|
| Inquiry | `POST /cash-withdrawal/inquiry/{accountId}` | Validate source account |
| Posting | `POST /cash-withdrawal/posting/{account_id}` | Execute cash withdrawal |
| Confirm | `POST /cash-withdrawal/posting/confirm/{account_id}` | Confirm ARPC validation |

**Flow**: Two-phase (inquiry + posting) like Transfer. Inquiry validates source bank account → Posting debits account → ARPC validation → confirm or reversal. Reuses `TransferService` and `TransferDto` internally.

**Integrations**: BBW server (ISO 8583), Kafka (transaction success events), Amplitude/CleverTap (analytics).

### 3. Balance Check (Balance Inquiry) [[source](https://github.com/bukuwarung/edc-adapter/blob/main/docs/features/balance-check.md)]

Allows EDC devices to query a cardholder's account balance.

| Phase | Endpoint | Purpose |
|-------|----------|---------|
| Check | `POST /balance/check/{account_id}` | Initiate balance inquiry |
| Confirm | `POST /balance/check/confirm/{account_id}` | Confirm ARPC validation |
| Reversal | `POST /transactions/reversal/{account_id}` | Reverse if ARPC fails |

**Flow**: EDC sends balance check request → validates card prefix, fetches terminal config, generates STAN → converts to ISO 8583 → routes to DC or DRC via load balancer → BBWClient sends async and polls for response via correlation key → response persisted and returned. ARPC chip validation then triggers confirm or reversal.

**Integrations**: BBW server (ISO 8583), Amplitude/CleverTap (analytics).

### 4. Key Exchange (Working Key Management) [[source](https://github.com/bukuwarung/edc-adapter/blob/main/docs/features/key-exchange.md)]

Generates and manages **Working Keys** -- short-term symmetric cryptographic keys used by EDC terminals to encrypt PIN blocks during financial transactions. This is a network management operation, not a financial transaction.

| Endpoint | Purpose |
|----------|---------|
| `POST /network/{accountId}/collect/token` | Retrieve or generate working key |

**Flow**: EDC requests working key → service checks for cached key (by terminal ID + user UUID) → if valid, returns cached → otherwise sends ISO 8583 Echo (MTI 0800) to BBW → BBW responds (MTI 0810) with working key in Field 48 → key is persisted in `working_key_store` table. A cron job (default 2 AM Jakarta time) refreshes all keys older than 24 hours.

**Integrations**: BBW server (ISO 8583 Echo messages).

### 5. Routing (Switcher Resolution) [[source](https://github.com/bukuwarung/edc-adapter/blob/main/docs/features/routing.md)]

Determines which payment switcher/provider (BBW_AJ, BBW_NOBU, BBW_RINTIS, etc.) handles each EDC transaction using a two-phase rule-based approach.

**Layer 1 - Switcher Resolution**:
1. App version check (legacy < 25002 → always BBW_AJ)
2. Device brand exclusion (Tianyu → BBW_AJ)
3. Feature flag check
4. Two-phase DB routing via `resolve_routing_single_query` PostgreSQL function:
   - **Phase 1**: Match terminal/merchant hierarchy by priority (TERMINAL_ID > MERCHANT_ID > TERMINAL_PREFIX > wildcard) from `routing_rules` table
   - **Phase 2**: Match card prefix + destination bank + transaction type from `routing_card_rules` table

**Layer 2 - DC/DRC Infrastructure Routing**:
After switcher is resolved, `LoadBalancerService` determines DC or DRC target based on strategy and real-time health checks.

### 6. Terminal Config (Device Management) [[source](https://github.com/bukuwarung/edc-adapter/blob/main/docs/features/terminal-config.md)]

Manages EDC device metadata, multi-switcher credentials (Artajasa/Nobu terminal and merchant IDs), and enforces device-level transaction authorization (BW17 restriction). No dedicated API endpoint -- used internally by all transaction flows.

**Key concern**: On every transaction, validates EDC user (buku-origin header + serial number against `terminal_configs` table). Provides switcher-specific credentials (`getSwitcherTerminalId()`/`getSwitcherMerchantId()`) for multi-provider support.

### 7. Transaction History [[source](https://github.com/bukuwarung/edc-adapter/blob/main/docs/features/transaction-history.md)]

Provides read-only endpoints for EDC devices to retrieve paginated historical transaction records.

| Endpoint | Purpose |
|----------|---------|
| `GET /transaction/history/{account_id}/v2` | Paginated transaction listing |
| `GET /transaction/history/{account_id}/detail/{transaction_id}` | Single transaction detail |

**Flow**: Executes PostgreSQL functions (`GET_TRANSACTION_HISTORY_V4`) that perform UNION queries across `transfer_posting` and `balance_inquiry` tables. Results are filtered, paginated, and mapped with transaction type mapping, `EndUserStatus` calculation, and switcher info extraction from metadata JSONB.

## Project Structure

```
edc-adapter/
|-- app/           # Main application, configurations
|-- adapters/      # External adapters (REST controllers, API layer)
|-- common/        # Shared utilities and constants
|-- core/          # Core domain logic and business rules
|-- persistence/   # Database entities and repositories (Flyway migrations)
|-- provider/      # External service integrations (BBWClient, ISO 8583)
|-- docs/          # Feature documentation
|-- testcases/     # Test case documentation
|-- plans/         # Implementation plans
|-- deployments/   # Kubernetes deployment configs
```

## API Routes

All routes are prefixed with `/edc-adapter/`:

| Route Pattern | Description |
|---------------|-------------|
| `POST /transfer/inquiry/{accountId}` | Transfer inquiry (validate destination) |
| `POST /transfer/posting/{account_id}` | Transfer posting (execute transfer) |
| `POST /transfer/posting/confirm/{account_id}` | Transfer confirm (ARPC validation) |
| `POST /cash-withdrawal/inquiry/{accountId}` | Cash withdrawal inquiry |
| `POST /cash-withdrawal/posting/{account_id}` | Cash withdrawal posting |
| `POST /cash-withdrawal/posting/confirm/{account_id}` | Cash withdrawal confirm |
| `POST /balance/check/{account_id}` | Balance inquiry |
| `POST /balance/check/confirm/{account_id}` | Balance check confirm |
| `POST /transactions/reversal/{account_id}` | Transaction reversal |
| `POST /network/{accountId}/collect/token` | Key exchange (working key) |
| `GET /transaction/history/{account_id}/v2` | Transaction history listing |
| `GET /transaction/history/{account_id}/detail/{transaction_id}` | Transaction detail |

## Dependencies / Integrations

### Internal Services
- **MiniATM Backend**: Transaction processing coordination
- **Payments Service**: Payment processing and settlement
- **Kafka Topics**: Event streaming for transaction success events

### External Dependencies
- **BBW Bank Server**: Primary financial backend via ISO 8583 over TCP (DC + DRC dual connections)
- **PostgreSQL**: Transaction persistence, routing rules, terminal configs, working key store
- **Kafka**: Event streaming for transaction processing
- **Amplitude / CleverTap**: Analytics and event tracking
- **AWS Secrets Manager**: Credential management

### Key Libraries
- **netty-iso8583 (jreactive8583)**: Reactive ISO 8583 message handling
- **j8583**: ISO 8583 message parsing
- **Spring Cloud OpenFeign**: External API clients
- **Spring Cloud Stream**: Kafka integration
- **Caffeine**: In-memory caching
- **Resilience4j**: Circuit breaker patterns

## Development

### Prerequisites
- Java 17
- Gradle
- PostgreSQL
- Kafka

### Build & Run
```bash
# Format code
make format

# Build the project
make build

# Run tests
make test

# Run all checks
make check

# Run the application
make run
```

### Code Quality
- Spotless for code formatting (Google Java Format)
- SpotBugs for static analysis
- JaCoCo for code coverage
- SonarQube integration

### Agentic Development Workflow
This project supports a structured development workflow with custom slash commands:
1. `/plan {jira-ticket}` - Create implementation plan
2. `/generate-test-cases {jira-ticket}` - Generate test cases
3. `/code {jira-ticket}` - Implement changes
4. `/review` - Perform code review
5. `/tech-doc {feature-name}` - Generate documentation

## Architecture Notes

This is a **production payment system** following hexagonal architecture where correctness, security, and reliability are paramount:
- **Domain Layer**: Pure business logic, no external dependencies
- **Application Layer**: Use cases and application services
- **Adapter Layer**: External integrations (BBW ISO 8583, databases, REST controllers)

Key architectural patterns:
- ISO 8583 message protocol for all bank communication
- Dual TCP connections (DC/DRC) with configurable load balancing strategies
- ARPC chip card validation with automatic reversal on failure
- Async request-response matching via correlation keys in `BBWConcurrentMap`
- Two-phase routing: switcher resolution (provider selection) + infrastructure routing (DC/DRC selection)
