# BukuWarung Backend Architecture

This document provides a high-level overview of the BukuWarung backend architecture, covering all services and their communication patterns.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Service Catalog](#service-catalog)
3. [Service Communication Patterns](#service-communication-patterns)
4. [Domain-Based Architecture](#domain-based-architecture)
5. [Data Flow Diagrams](#data-flow-diagrams)
6. [Technology Stack](#technology-stack)
7. [Infrastructure & Deployment](#infrastructure--deployment)
8. [External Integrations](#external-integrations)

---

## Architecture Overview

BukuWarung's backend follows a **microservices architecture** with 34 independently deployable services. The platform uses an **API Gateway pattern** with Spring Cloud Gateway as the central entry point.

```
                                    ┌─────────────────────────────────────────┐
                                    │            External Clients              │
                                    │   (Mobile Apps, Web, Partner Systems)   │
                                    └─────────────────┬───────────────────────┘
                                                      │
                                                      ▼
                              ┌────────────────────────────────────────────────┐
                              │              APP-GATEWAY                        │
                              │         (Spring Cloud Gateway)                  │
                              │  • Firebase Authentication                      │
                              │  • Rate Limiting (Redis)                        │
                              │  • Request Routing                              │
                              │  • Request Filtering                            │
                              └────────────────────────┬───────────────────────┘
                                                       │
       ┌───────────────────────────┬───────────────────┼───────────────────┬───────────────────────────┐
       │                           │                   │                   │                           │
       ▼                           ▼                   ▼                   ▼                           ▼
┌─────────────────┐     ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐    ┌─────────────────┐
│    PLATFORM     │     │    PAYMENTS     │   │     LENDING     │   │       BAU       │    │ DATA & ANALYTICS│
│                 │     │                 │   │                 │   │                 │    │                 │
│ • auth          │     │ • payments      │   │ • los-lender    │   │ • finpro        │    │ • dracula-v2    │
│ • accounting    │     │ • banking       │   │ • los-web       │   │ • tokoko        │    │ • data-analytics│
│ • notification  │     │ • banking-batch │   │ • fs-bnpl       │   │ • loyalty       │    │ • transaction-  │
│ • janus         │     │ • edc-adapter   │   │ • lms-client    │   │ • retail        │    │   history       │
│ • risk          │     │ • miniatm       │   │                 │   │ • rafana        │    │                 │
│ • rule-engine   │     │ • bni-gateway   │   │                 │   │ • digital-prod  │    │                 │
│ • golden-gate   │     │ • payments-mweb │   │                 │   │                 │    │                 │
│ • panacea       │     │                 │   │                 │   │                 │    │                 │
└─────────────────┘     └─────────────────┘   └─────────────────┘   └─────────────────┘    └─────────────────┘
       │                           │                   │                   │                           │
       └───────────────────────────┴───────────────────┴───────────────────┴───────────────────────────┘
                                                       │
                                                       ▼
                              ┌────────────────────────────────────────────────┐
                              │           SHARED INFRASTRUCTURE                 │
                              │                                                 │
                              │  ┌──────────┐  ┌─────────┐  ┌──────────────┐  │
                              │  │PostgreSQL│  │  Redis  │  │    Kafka     │  │
                              │  └──────────┘  └─────────┘  └──────────────┘  │
                              └────────────────────────────────────────────────┘
```

### Key Architecture Patterns

| Pattern | Implementation |
|---------|----------------|
| **API Gateway** | Spring Cloud Gateway (app-gateway) |
| **Event-Driven** | Apache Kafka for async communication |
| **Hexagonal Architecture** | Ports & Adapters in los-lender, finpro, janus, edc-adapter |
| **Reactive Programming** | WebFlux in banking, transaction-history, miniatm-backend |
| **Circuit Breaker** | Resilience4j for fault tolerance |
| **Centralized Config** | Spring Cloud Config Server |

---

## Service Catalog

### By Domain

#### 1. Platform

Core platform services that provide foundational capabilities across the entire system.

| Service | Description | Java | Spring Boot | Build | Doc Reference |
|---------|-------------|------|-------------|-------|---------------|
| **multi-tenant-auth** | Authentication, JWT, OTP, multi-tenant support | 21 | 3.3 | Gradle | [`c3b48f6`](https://github.com/bukuwarung/multi-tenant-auth/commit/c3b48f6269e99c62b547222d8aa23ca566c766da) |
| **accounting-service** | Business ledgers, transactions, B2B supplier | 8 | 2.4 | Maven | [`c58e12a`](https://github.com/bukuwarung/accounting-service/commit/c58e12a15e800ef1cfaf508171bd299c2edb5e7b) |
| **notification** | Multi-channel notifications (SMS, WA, Email, Push) | 8 | 2.3 | Maven | [`490925c`](https://github.com/bukuwarung/notification/commit/490925cc0452e4e2a660fb9db2404d142792abb6) |
| **janus** | KYC/KYB verification, OCR, face matching | 11 | 2.5 | Maven | [`261afd5`](https://github.com/bukuwarung/janus/commit/261afd51b067879a4c0dd2d8f47074bbcc72988c) |
| **kyc-liveliness** | VIDA integration for passive liveliness | - | - | - | [`6da1e2a`](https://github.com/bukuwarung/kyc-liveliness/commit/6da1e2adc8da7f1992f25b7f1a30d1d1f59f5412) |
| **user-trust** | Fraud detection and user trust scoring | - | - | - | [`eee64f8`](https://github.com/bukuwarung/user-trust/commit/eee64f8effd82a8c2e024813c9724d7ec3fd7f71) |
| **risk** | Risk assessment, fraud detection, credit evaluation | 11 | 2.5 | Gradle | [`0e26dc4`](https://github.com/bukuwarung/risk/commit/0e26dc44610fb20aacbd0b581ea2f924363865e3) |
| **rule-engine** | Business rules engine (Drools) | 11 | 2.6 | Gradle | [`68735f7`](https://github.com/bukuwarung/rule-engine/commit/68735f77e6c530869eba6da2aee6d1281513e662) |
| **golden-gate** | Payment portal backend | 11 | 2.7 | Gradle | [`97c679a`](https://github.com/bukuwarung/golden-gate/commit/97c679a56e82c304518bd9e3001ca7e710ca3591) |
| **panacea** | Internal admin dashboard | Next.js 12 | React 17 | Yarn | [`8931946`](https://github.com/bukuwarung/panacea/commit/893194611cbe0503e7c727c45b34e799700e9dce) |

#### 2. Payments

Payment processing, banking operations, terminal transactions, and financial services.

| Service | Description | Java | Spring Boot | Build | Doc Reference |
|---------|-------------|------|-------------|-------|---------------|
| **payments** | Payment processing, disbursements, virtual accounts | 8 | 2.3 | Maven | [`3a24469`](https://github.com/bukuwarung/payments/commit/3a24469bae87e82aabe59ffb6198b192081935b3) |
| **banking** | Banking operations, accounts, transfers (Reactive) | 11 | JHipster 7.1 | Gradle | [`e6bf5cd`](https://github.com/bukuwarung/banking/commit/e6bf5cd82589de661ebb0ba3c9edd2e69488b44d) |
| **banking-batch** | Banking batch operations | 11 | 2.5 | Gradle | [`8e195a1`](https://github.com/bukuwarung/banking-batch/commit/8e195a1cd73bb92a203b572dc33bc7a07e294333) |
| **banking-bni-gateway** | BNI banking gateway integration | - | - | - | [`bbeb0a3`](https://github.com/bukuwarung/payments-saldo/commit/bbeb0a30b5ed7adce61308e67e6a8ed7c89943ae) |
| **edc-adapter** | EDC terminal middleware, ISO 8583 | 17 | 3.2 | Gradle | [`ddec74f`](https://github.com/bukuwarung/edc-adapter/commit/ddec74f8187f2febec1971ab1340eb69eb35a7f3) |
| **miniatm-backend** | ATM card services (Reactive) | 21 | 3.3 | Gradle | [`c5a5ba7`](https://github.com/bukuwarung/miniatm-backend/commit/c5a5ba7aa8f447757cd7655733fa9cc2f2882d65) |
| **payments-config-server** | Centralized payment configuration | - | - | - | [`38b4227`](https://github.com/bukuwarung/payments-config-server/commit/38b4227ec04120c56ea4631bd3c78fc1df567786) |
| **payments-mweb** | Mobile web for payments | - | - | Web | [`b91435d`](https://github.com/bukuwarung/payments-mweb/commit/b91435d8c41c5022ada61a970cc058d34756d256) |

#### 3. Lending

Loan origination, management, and Buy Now Pay Later services.

| Service | Description | Java | Spring Boot | Build | Doc Reference |
|---------|-------------|------|-------------|-------|---------------|
| **los-lender** | Loan Origination System | 11 | 2.6 | Gradle | [`98f5f5e`](https://github.com/bukuwarung/los-lender/commit/98f5f5ec8e7429d6763499ae893c291989f4059c) |
| **los-web** | LOS web frontend | - | - | - | [`9236039`](https://github.com/bukuwarung/los-web/commit/9236039ddf24513fa73eb4b584c3b598af0b5b1b) |
| **fs-bnpl-service** | Buy Now Pay Later, merchant onboarding | 11 | 2.6 | Gradle | [`36ef907`](https://github.com/bukuwarung/fs-bnpl-service/commit/36ef9079cdfa4e4f6446e6632cb672763b86b7ac) |
| **lms-client** | Loan Management System (Hypercore integration) | - | - | - | [`dc5767b`](https://github.com/bukuwarung/lms-client/commit/dc5767b6d6b1831d6368f1995dcd16f45a3b210b) |

#### 4. BAU (Business As Usual)

Day-to-day business operations including digital products, e-commerce, loyalty, and partner integrations.

| Service | Description | Java | Spring Boot | Build | Doc Reference |
|---------|-------------|------|-------------|-------|---------------|
| **finpro** | Digital products, PPOB, prepaid services | 8 | 2.4 | Maven | [`738602f`](https://github.com/bukuwarung/finpro/commit/738602f351ad38f7ebd0a64c9598fa725b09b5b3) |
| **tokoko-service** | E-commerce platform, product catalog, orders | 8+ | 2.4 | Maven | [`82be993`](https://github.com/bukuwarung/tokoko-service/commit/82be993c7f51e1f299e22506f7602525cad9f920) |
| **loyalty** | Loyalty rewards program | 8 | 2.4 | Maven | [`918ff2e`](https://github.com/bukuwarung/loyalty/commit/918ff2e914d0640ec1b057e60a123f6ad06bc057) |
| **rafana** | B2B partner service wrapper | - | - | - | - |
| **retail-backend** | BukuPay Retail, QRIS transactions | - | - | - | [`d3812d1`](https://github.com/bukuwarung/retail-backend/commit/d3812d1b2dc12529fdb6d53710e13bbd5f954663) |
| **digital-product-adapter** | Digital product aggregation | - | - | - | [`db3cf0a`](https://github.com/bukuwarung/digital-product-adapter/commit/db3cf0a70bbace53242603a4925d180fc4efd3c8) |

#### 5. Data & Analytics

Data pipelines, analytics, and transaction history services.

| Service | Description | Java | Spring Boot | Build | Doc Reference |
|---------|-------------|------|-------------|-------|---------------|
| **dracula-v2** | Kafka consumer, data pipeline, event processing | 21 | 3.3 | Gradle | [`bf941f9`](https://github.com/bukuwarung/dracula-v2/commit/bf941f943d177ccf1bf7630524e4bc88ee230fca) |
| **data-analytics** | Analytics, BigQuery integration | 8 | 2.4 | Maven | [`7ece276`](https://github.com/bukuwarung/data-analytics/commit/7ece2765eccb02b68beaa8542d63ee71c06cb7b8) |
| **transaction-history** | Transaction aggregation and search (Reactive) | 17 | 2.7 | Gradle | [`cbfc481`](https://github.com/bukuwarung/transaction-history/commit/cbfc481d88734e73934d3b3a3308d3a4d74290a1) |

---

## Service Communication Patterns

### Communication Matrix

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              SERVICE COMMUNICATION OVERVIEW                                       │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                   │
│  ┌──────────────────┐                              ┌──────────────────┐                          │
│  │ SYNCHRONOUS      │                              │ ASYNCHRONOUS     │                          │
│  │ (REST/HTTP)      │                              │ (Kafka Events)   │                          │
│  │                  │                              │                  │                          │
│  │ • OpenFeign      │                              │ • Spring Cloud   │                          │
│  │ • WebClient      │                              │   Stream         │                          │
│  │ • RestTemplate   │                              │ • Spring Kafka   │                          │
│  └────────┬─────────┘                              └────────┬─────────┘                          │
│           │                                                 │                                     │
│           ▼                                                 ▼                                     │
│  ┌────────────────────────────────────────────────────────────────────────────────────────────┐ │
│  │                              DOMAIN COMMUNICATION                                           │ │
│  ├────────────────────────────────────────────────────────────────────────────────────────────┤ │
│  │                                                                                             │ │
│  │  ┌──────────────────────────────────────────────────────────────────────────────────────┐ │ │
│  │  │                                    PLATFORM                                           │ │ │
│  │  │   auth ◄────► accounting ◄────► janus ◄────► risk ◄────► rule-engine                │ │ │
│  │  │     │            │                │             │              │                      │ │ │
│  │  │     │            │                │             │              │                      │ │ │
│  │  │     │        notification ◄───────┴─────────────┴──────────────┘                      │ │ │
│  │  └─────┼────────────┼────────────────────────────────────────────────────────────────────┘ │ │
│  │        │            │                                                                      │ │
│  │        ▼            ▼                                                                      │ │
│  │  ┌───────────┐ ┌───────────┐ ┌───────────────────────────────────────────────────────┐   │ │
│  │  │ PAYMENTS  │ │  LENDING  │ │                        BAU                             │   │ │
│  │  │           │ │           │ │                                                        │   │ │
│  │  │ payments  │ │los-lender │ │  finpro ◄──► tokoko ◄──► loyalty                      │   │ │
│  │  │    │      │ │    │      │ │       │                                                │   │ │
│  │  │ banking   │◄┤ fs-bnpl   │ │    rafana ◄──► digital-product-adapter ◄──► retail   │   │ │
│  │  │    │      │ │    │      │ │                                                        │   │ │
│  │  │edc-adapter│ │lms-client │ │                                                        │   │ │
│  │  │    │      │ │           │ │                                                        │   │ │
│  │  │ miniatm   │ │           │ │                                                        │   │ │
│  │  └─────┬─────┘ └─────┬─────┘ └───────────────────────┬───────────────────────────────┘   │ │
│  │        │             │                               │                                    │ │
│  └────────┴─────────────┴───────────────────────────────┴────────────────────────────────────┘ │
│                                             │                                                   │
│                                             ▼                                                   │
│  ┌────────────────────────────────────────────────────────────────────────────────────────────┐ │
│  │                                    KAFKA EVENT BUS                                          │ │
│  │                                                                                             │ │
│  │  Topics: transactions, payments, user-events, loyalty, risk, banking, miniatm-events       │ │
│  │                                                                                             │ │
│  │  Publishers:                              Consumers:                                        │ │
│  │  • accounting-service (Platform)          • dracula-v2 (Data & Analytics)                  │ │
│  │  • payments (Payments)                    • loyalty (BAU)                                   │ │
│  │  • banking (Payments)                     • risk (Platform)                                 │ │
│  │  • miniatm-backend (Payments)             • transaction-history (Data & Analytics)         │ │
│  │  • loyalty (BAU)                          • banking (Payments)                              │ │
│  └────────────────────────────────────────────┬───────────────────────────────────────────────┘ │
│                                               │                                                  │
│                                               ▼                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────────────────────┐ │
│  │                                  DATA & ANALYTICS                                           │ │
│  │                                                                                             │ │
│  │             dracula-v2 ────► data-analytics ────► transaction-history                      │ │
│  │            (pipeline)          (BigQuery)              (search)                             │ │
│  └────────────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                                   │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Synchronous Communication (HTTP/REST)

Services communicate synchronously using:
- **Spring Cloud OpenFeign** - Declarative REST clients
- **WebClient** - Reactive non-blocking HTTP client
- **RestTemplate** - Traditional blocking HTTP client

#### Key Service Dependencies

**Cross-Domain Dependencies:**

| Source Domain | Source Service | Target Domain | Target Service | Purpose |
|---------------|----------------|---------------|----------------|---------|
| Lending | los-lender | Platform | multi-tenant-auth | User verification |
| Lending | los-lender | Platform | janus | KYC status check |
| Lending | los-lender | Platform | risk | Credit assessment |
| Lending | los-lender | Lending | fs-bnpl-service | Merchant limits |
| Lending | los-lender | Lending | lms-client | Hypercore integration |
| Payments | payments | Platform | rule-engine | Dynamic routing |
| Payments | payments | Platform | notification | Send confirmations |
| Payments | payments | Platform | accounting-service | Ledger updates |
| Payments | edc-adapter | Payments | miniatm-backend | Transaction coordination |
| Payments | miniatm-backend | Payments | payments | Settlement |
| Lending | fs-bnpl-service | Payments | payments | Payment processing |
| Lending | fs-bnpl-service | Platform | notification | Reminders |
| BAU | tokoko-service | Platform | notification | Order notifications |
| BAU | finpro | Platform | accounting-service | Balance updates |
| BAU | loyalty | Platform | notification | Reward notifications |

### Asynchronous Communication (Kafka)

Event-driven communication via Apache Kafka enables loose coupling and high throughput.

#### Kafka Topics & Participants

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                               KAFKA TOPIC ECOSYSTEM                                      │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  TOPIC: transactions                                                                     │
│  ├─ Publishers: accounting-service [Platform], payments [Payments]                       │
│  └─ Consumers: dracula-v2 [Data], transaction-history [Data], loyalty [BAU]             │
│                                                                                          │
│  TOPIC: payments                                                                         │
│  ├─ Publishers: payments [Payments], banking [Payments]                                  │
│  └─ Consumers: dracula-v2 [Data], risk [Platform], notification [Platform]              │
│                                                                                          │
│  TOPIC: user-events                                                                      │
│  ├─ Publishers: multi-tenant-auth [Platform], accounting-service [Platform]              │
│  └─ Consumers: dracula-v2 [Data], loyalty [BAU], risk [Platform]                        │
│                                                                                          │
│  TOPIC: loyalty-activities                                                               │
│  ├─ Publishers: loyalty [BAU], payments [Payments]                                       │
│  └─ Consumers: dracula-v2 [Data], notification [Platform]                               │
│                                                                                          │
│  TOPIC: banking-events                                                                   │
│  ├─ Publishers: banking [Payments], banking-batch [Payments]                             │
│  └─ Consumers: dracula-v2 [Data], transaction-history [Data]                            │
│                                                                                          │
│  TOPIC: miniatm-events                                                                   │
│  ├─ Publishers: miniatm-backend [Payments], edc-adapter [Payments]                       │
│  └─ Consumers: dracula-v2 [Data]                                                        │
│                                                                                          │
│  TOPIC: lending-events                                                                   │
│  ├─ Publishers: los-lender [Lending], fs-bnpl-service [Lending]                          │
│  └─ Consumers: dracula-v2 [Data], risk [Platform]                                       │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Domain-Based Architecture

### Domain Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    BUKUWARUNG DOMAINS                                            │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                  │
│   ┌─────────────────────────────────────────────────────────────────────────────────────────┐   │
│   │                                    PLATFORM                                              │   │
│   │                        (Foundation services used by all domains)                         │   │
│   │                                                                                          │   │
│   │    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │   │
│   │    │multi-tenant- │  │  accounting  │  │ notification │  │    janus     │              │   │
│   │    │    auth      │  │   service    │  │              │  │  (KYC/KYB)   │              │   │
│   │    └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘              │   │
│   │    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │   │
│   │    │kyc-liveliness│  │  user-trust  │  │     risk     │  │ rule-engine  │              │   │
│   │    └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘              │   │
│   │    ┌──────────────┐  ┌──────────────┐                                                   │   │
│   │    │ golden-gate  │  │   panacea    │                                                   │   │
│   │    │(payment portal)│ │(admin portal)│                                                   │   │
│   │    └──────────────┘  └──────────────┘                                                   │   │
│   └──────────────────────────────────────────────┬──────────────────────────────────────────┘   │
│                                                  │                                               │
│                  ┌───────────────────────────────┼───────────────────────────────┐              │
│                  │                               │                               │              │
│                  ▼                               ▼                               ▼              │
│   ┌─────────────────────────┐    ┌─────────────────────────┐    ┌─────────────────────────┐   │
│   │        PAYMENTS         │    │         LENDING         │    │           BAU           │   │
│   │                         │    │                         │    │   (Business As Usual)   │   │
│   │  ┌─────────────────┐   │    │  ┌─────────────────┐   │    │                         │   │
│   │  │    payments     │   │    │  │   los-lender    │   │    │  ┌─────────────────┐   │   │
│   │  │   (core txns)   │   │    │  │      (LOS)      │   │    │  │     finpro      │   │   │
│   │  └─────────────────┘   │    │  └─────────────────┘   │    │  │  (PPOB/digital) │   │   │
│   │  ┌─────────────────┐   │    │  ┌─────────────────┐   │    │  └─────────────────┘   │   │
│   │  │    banking      │   │    │  │    los-web      │   │    │  ┌─────────────────┐   │   │
│   │  │   (accounts)    │   │    │  │   (frontend)    │   │    │  │ tokoko-service  │   │   │
│   │  └─────────────────┘   │    │  └─────────────────┘   │    │  │  (e-commerce)   │   │   │
│   │  ┌─────────────────┐   │    │  ┌─────────────────┐   │    │  └─────────────────┘   │   │
│   │  │  banking-batch  │   │    │  │ fs-bnpl-service │   │    │  ┌─────────────────┐   │   │
│   │  └─────────────────┘   │    │  │     (BNPL)      │   │    │  │    loyalty      │   │   │
│   │  ┌─────────────────┐   │    │  └─────────────────┘   │    │  │   (rewards)     │   │   │
│   │  │banking-bni-     │   │    │  ┌─────────────────┐   │    │  └─────────────────┘   │   │
│   │  │    gateway      │   │    │  │   lms-client    │   │    │  ┌─────────────────┐   │   │
│   │  └─────────────────┘   │    │  │  (Hypercore)    │   │    │  │ retail-backend  │   │   │
│   │  ┌─────────────────┐   │    │  └─────────────────┘   │    │  │    (QRIS)       │   │   │
│   │  │   edc-adapter   │   │    │                         │    │  └─────────────────┘   │   │
│   │  │  (EDC terminal) │   │    │                         │    │  ┌─────────────────┐   │   │
│   │  └─────────────────┘   │    │                         │    │  │     rafana      │   │   │
│   │  ┌─────────────────┐   │    │                         │    │  │  (B2B partner)  │   │   │
│   │  │miniatm-backend  │   │    │                         │    │  └─────────────────┘   │   │
│   │  │   (Mini ATM)    │   │    │                         │    │  ┌─────────────────┐   │   │
│   │  └─────────────────┘   │    │                         │    │  │digital-product  │   │   │
│   │  ┌─────────────────┐   │    │                         │    │  │    adapter      │   │   │
│   │  │payments-config  │   │    │                         │    │  └─────────────────┘   │   │
│   │  │    server       │   │    │                         │    │                         │   │
│   │  └─────────────────┘   │    │                         │    │                         │   │
│   │  ┌─────────────────┐   │    │                         │    │                         │   │
│   │  │ payments-mweb   │   │    │                         │    │                         │   │
│   │  └─────────────────┘   │◄──►│                         │◄──►│                         │   │
│   └─────────────────────────┘    └─────────────────────────┘    └─────────────────────────┘   │
│                  │                               │                               │              │
│                  └───────────────────────────────┼───────────────────────────────┘              │
│                                                  │                                               │
│                                                  ▼                                               │
│   ┌─────────────────────────────────────────────────────────────────────────────────────────┐   │
│   │                                  DATA & ANALYTICS                                        │   │
│   │                          (Event processing and analytics layer)                          │   │
│   │                                                                                          │   │
│   │    ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐                 │   │
│   │    │    dracula-v2    │    │  data-analytics  │    │transaction-history│                 │   │
│   │    │  (Kafka pipeline)│    │    (BigQuery)    │    │    (search)      │                 │   │
│   │    └──────────────────┘    └──────────────────┘    └──────────────────┘                 │   │
│   └─────────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Domain Responsibilities

| Domain | Responsibility | Key Services |
|--------|----------------|--------------|
| **Platform** | Authentication, identity verification, risk assessment, business rules, core accounting, notifications, payment portal | multi-tenant-auth, janus, risk, rule-engine, accounting-service, notification, golden-gate |
| **Payments** | Payment processing, banking operations, terminal transactions, virtual accounts, disbursements | payments, banking, edc-adapter, miniatm-backend, banking-bni-gateway, payments-config-server |
| **Lending** | Loan origination, BNPL, credit management, lender integrations | los-lender, fs-bnpl-service, lms-client |
| **BAU** | Digital products (PPOB), e-commerce, loyalty rewards, partner integrations | finpro, tokoko-service, loyalty, rafana, retail-backend |
| **Data & Analytics** | Event streaming, data pipelines, analytics, transaction history | dracula-v2, data-analytics, transaction-history |

### Inter-Domain Communication

```
                              ┌─────────────────────────────────────────────────┐
                              │                   PLATFORM                       │
                              │  (Foundation services - used by all domains)    │
                              └──────────────────────┬──────────────────────────┘
                                                     │
                         ┌───────────────────────────┼───────────────────────────┐
                         │                           │                           │
                         ▼                           ▼                           ▼
              ┌─────────────────────┐    ┌─────────────────────┐    ┌─────────────────────┐
              │      PAYMENTS       │◄──►│       LENDING       │◄──►│         BAU         │
              │                     │    │                     │    │                     │
              │ • Processes txns    │    │ • Loan origination  │    │ • Digital products  │
              │ • Banking ops       │    │ • BNPL services     │    │ • E-commerce        │
              │ • Terminal txns     │    │ • Credit mgmt       │    │ • Loyalty rewards   │
              └──────────┬──────────┘    └──────────┬──────────┘    └──────────┬──────────┘
                         │                          │                          │
                         └──────────────────────────┼──────────────────────────┘
                                                    │
                                                    ▼
                              ┌─────────────────────────────────────────────────┐
                              │               DATA & ANALYTICS                   │
                              │    (Consumes events from all other domains)     │
                              └─────────────────────────────────────────────────┘
```

**Communication Patterns:**

| From Domain | To Domain | Pattern | Example |
|-------------|-----------|---------|---------|
| Payments | Platform | Sync (REST) | payments → rule-engine for routing |
| Payments | Platform | Sync (REST) | payments → notification for confirmations |
| Payments | Platform | Sync (REST) | miniatm → accounting-service for ledger |
| Lending | Platform | Sync (REST) | los-lender → janus for KYC check |
| Lending | Platform | Sync (REST) | los-lender → risk for credit assessment |
| Lending | Payments | Sync (REST) | fs-bnpl → payments for processing |
| BAU | Platform | Sync (REST) | tokoko → notification for orders |
| BAU | Platform | Sync (REST) | finpro → accounting-service for balance |
| All Domains | Data & Analytics | Async (Kafka) | Events → dracula-v2 pipeline |

---

## Data Flow Diagrams

### 1. Authentication Flow

```
┌─────────┐     ┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│ Client  │────►│ App-Gateway │────►│ multi-tenant-auth │────►│  PostgreSQL │
└─────────┘     │             │     │                  │     └─────────────┘
                │ • Firebase  │     │ • OTP Generation │
                │   Auth      │     │ • JWT Issuance   │          │
                │ • Rate      │     │ • Session Mgmt   │          │
                │   Limiting  │     │                  │          ▼
                └─────────────┘     └──────────────────┘     ┌─────────────┐
                                            │                │    Redis    │
                                            └───────────────►│  (Session)  │
                                                             └─────────────┘
```

### 2. Payment Processing Flow

```
┌─────────┐     ┌─────────────┐     ┌────────────┐     ┌─────────────┐
│ Client  │────►│ App-Gateway │────►│  payments  │────►│ rule-engine │
└─────────┘     └─────────────┘     └─────┬──────┘     └─────────────┘
                                          │                   │
                                          │◄──────────────────┘
                                          │ (routing decision)
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    │                     │                     │
                    ▼                     ▼                     ▼
            ┌─────────────┐      ┌──────────────┐      ┌─────────────┐
            │ notification│      │  accounting  │      │    Kafka    │
            │  (SMS/Push) │      │  (ledger)    │      │  (events)   │
            └─────────────┘      └──────────────┘      └──────┬──────┘
                                                               │
                                          ┌────────────────────┼─────────────┐
                                          │                    │             │
                                          ▼                    ▼             ▼
                                   ┌────────────┐      ┌───────────┐  ┌──────────┐
                                   │ dracula-v2 │      │  loyalty  │  │   risk   │
                                   │ (pipeline) │      │ (rewards) │  │(scoring) │
                                   └────────────┘      └───────────┘  └──────────┘
```

### 3. Loan Origination Flow

```
┌─────────┐     ┌─────────────┐     ┌────────────┐
│ Client  │────►│ App-Gateway │────►│ los-lender │
└─────────┘     └─────────────┘     └─────┬──────┘
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              │                           │                           │
              ▼                           ▼                           ▼
      ┌──────────────────┐        ┌─────────────┐            ┌──────────────┐
      │ multi-tenant-auth│        │    janus    │            │     risk     │
      │ (user verify)    │        │ (KYC check) │            │ (credit eval)│
      └──────────────────┘        └─────────────┘            └──────────────┘
                                          │
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              │                           │                           │
              ▼                           ▼                           ▼
      ┌──────────────────┐        ┌─────────────┐            ┌──────────────┐
      │  fs-bnpl-service │        │  lms-client │            │ notification │
      │ (merchant limit) │        │ (Hypercore) │            │ (approval)   │
      └──────────────────┘        └─────────────┘            └──────────────┘
```

### 4. EDC/Terminal Transaction Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────────┐
│ EDC Terminal│────►│ edc-adapter │────►│ miniatm-backend │
│ (ISO 8583)  │     │             │     │    (WebFlux)    │
└─────────────┘     └─────────────┘     └───────┬─────────┘
                                                │
                    ┌───────────────────────────┼──────────────────┐
                    │                           │                  │
                    ▼                           ▼                  ▼
            ┌─────────────┐            ┌─────────────┐     ┌─────────────┐
            │  payments   │            │    Kafka    │     │ accounting  │
            │ (settlement)│            │  (events)   │     │  (ledger)   │
            └─────────────┘            └──────┬──────┘     └─────────────┘
                                              │
                                              ▼
                                       ┌─────────────┐
                                       │ dracula-v2  │
                                       │ (pipeline)  │
                                       └─────────────┘
```

### 5. E-Commerce Flow (Tokoko)

```
┌─────────┐     ┌─────────────┐     ┌────────────────┐
│ Client  │────►│ App-Gateway │────►│ tokoko-service │
└─────────┘     └─────────────┘     └───────┬────────┘
                                            │
                ┌───────────────────────────┼───────────────────────────┐
                │                           │                           │
                ▼                           ▼                           ▼
        ┌─────────────────┐         ┌─────────────┐            ┌──────────────┐
        │  Elasticsearch  │         │   Shipper   │            │ notification │
        │ (product search)│         │ (logistics) │            │   (order)    │
        └─────────────────┘         └─────────────┘            └──────────────┘
                                            │
                                            ▼
                                    ┌─────────────┐
                                    │  Firebase   │
                                    │   (push)    │
                                    └─────────────┘
```

---

## Technology Stack

### Languages & Runtimes

| Version | Services |
|---------|----------|
| **Java 21** | multi-tenant-auth, dracula-v2, miniatm-backend |
| **Java 17** | transaction-history, edc-adapter |
| **Java 11** | los-lender, risk, banking, janus, golden-gate, fs-bnpl |
| **Java 8** | accounting, payments, finpro, loyalty, data-analytics |
| **TypeScript** | Panacea (Next.js) |

### Frameworks & Libraries

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TECHNOLOGY STACK                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  FRAMEWORKS                           DATA ACCESS                            │
│  ┌─────────────────────────┐          ┌─────────────────────────┐           │
│  │ Spring Boot (2.3 - 3.3) │          │ Spring Data JPA         │           │
│  │ Spring Cloud            │          │ Hibernate               │           │
│  │ Spring Security         │          │ R2DBC (Reactive)        │           │
│  │ Spring WebFlux          │          │ Flyway/Liquibase        │           │
│  │ JHipster (banking)      │          └─────────────────────────┘           │
│  │ Next.js (panacea)       │                                                │
│  └─────────────────────────┘          MESSAGING                             │
│                                       ┌─────────────────────────┐           │
│  BUILD TOOLS                          │ Spring Kafka            │           │
│  ┌─────────────────────────┐          │ Spring Cloud Stream     │           │
│  │ Maven (older services)  │          │ Apache Kafka Client     │           │
│  │ Gradle (newer services) │          └─────────────────────────┘           │
│  │ Yarn (panacea)          │                                                │
│  └─────────────────────────┘          SPECIALIZED                           │
│                                       ┌─────────────────────────┐           │
│  RESILIENCE                           │ Drools (rule-engine)    │           │
│  ┌─────────────────────────┐          │ j8583 (ISO 8583)        │           │
│  │ Resilience4j            │          │ Flying Saucer (PDF)     │           │
│  │ Circuit Breaker         │          │ Apache POI (Excel)      │           │
│  │ Rate Limiting (Redis)   │          │ Elasticsearch           │           │
│  └─────────────────────────┘          └─────────────────────────┘           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Data Storage

| Type | Technology | Services Using |
|------|------------|----------------|
| **Relational** | PostgreSQL | All services |
| **Cache** | Redis (Redisson) | payments, auth, janus, loyalty, risk, dracula-v2 |
| **Search** | Elasticsearch | tokoko-service |
| **Analytics** | Google BigQuery | data-analytics |
| **Documents** | AWS S3 | Multiple services |
| **Real-time** | Firestore | accounting-service |

---

## Infrastructure & Deployment

### Deployment Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DEPLOYMENT TOPOLOGY                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                    ┌─────────────────────────────────┐                      │
│                    │          AWS CLOUD              │                      │
│                    │                                 │                      │
│   ┌────────────────┴─────────────────────────────────┴────────────────┐    │
│   │                        AWS ECS (Copilot)                          │    │
│   │   ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐        │    │
│   │   │ Service 1 │ │ Service 2 │ │ Service 3 │ │    ...    │        │    │
│   │   │ Container │ │ Container │ │ Container │ │ Container │        │    │
│   │   └───────────┘ └───────────┘ └───────────┘ └───────────┘        │    │
│   └───────────────────────────────────────────────────────────────────┘    │
│                                    │                                        │
│        ┌───────────────────────────┼───────────────────────────┐           │
│        │                           │                           │            │
│        ▼                           ▼                           ▼            │
│  ┌───────────┐            ┌───────────────┐           ┌───────────────┐    │
│  │  AWS RDS  │            │ AWS Secrets   │           │  AWS S3       │    │
│  │PostgreSQL │            │ Manager       │           │ (Documents)   │    │
│  └───────────┘            └───────────────┘           └───────────────┘    │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────┐    │
│  │                     External Services                              │    │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐ │    │
│  │  │Elastica-│  │  Redis  │  │  Kafka  │  │ Firebase│  │ BigQuery│ │    │
│  │  │ che     │  │(Managed)│  │(Managed)│  │         │  │         │ │    │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘  └─────────┘ │    │
│  └───────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Configuration Management

| Component | Technology |
|-----------|------------|
| **Centralized Config** | Spring Cloud Config Server |
| **Secret Management** | AWS Secrets Manager |
| **Parameters** | AWS SSM Parameter Store |
| **Config Refresh** | Spring Cloud Bus (Kafka) |

### Observability

| Component | Technology |
|-----------|------------|
| **APM** | Datadog |
| **Logging** | Logback + Logstash |
| **Metrics** | Prometheus/Micrometer |
| **Error Tracking** | Sentry |

---

## External Integrations

### Payment Providers

| Provider | Purpose |
|----------|---------|
| **Xendit** | Payment gateway |
| **DOKU** | Payment gateway |
| **Various Banks** | Banking integrations |

### Communication Providers

| Provider | Purpose |
|----------|---------|
| **Twilio** | SMS/OTP |
| **MessageBird** | SMS |
| **Wavecell** | SMS |
| **Firebase (FCM)** | Push notifications |
| **AWS SES** | Email |
| **AWS SNS** | Notifications |

### Identity Verification

| Provider | Purpose |
|----------|---------|
| **OCR Providers** | Document scanning |
| **Face Recognition APIs** | Biometric verification |
| **Dukcapil** | Indonesian government data |
| **VIDA** | Liveliness detection |

### Other Integrations

| Provider | Purpose |
|----------|---------|
| **Shipper** | Logistics (Tokoko) |
| **Google BigQuery** | Analytics |
| **Amplitude** | Product analytics |
| **MoEngage** | Customer engagement |
| **Hypercore** | Loan management |

---

## Security Architecture

### Authentication & Authorization

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        SECURITY LAYERS                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  LAYER 1: Gateway Security                                               │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │ • Firebase Authentication (client apps)                         │    │
│  │ • Rate Limiting (Redis-based)                                   │    │
│  │ • Request Filtering                                             │    │
│  │ • CORS Handling                                                 │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  LAYER 2: Service Security                                               │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │ • JWT Token Validation                                          │    │
│  │ • Spring Security Integration                                   │    │
│  │ • Role-Based Access Control (RBAC)                             │    │
│  │ • Multi-Tenant Isolation                                        │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  LAYER 3: Partner Security                                               │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │ • Request Signature Validation (Rafana)                         │    │
│  │ • Request Integrity Checks                                      │    │
│  │ • Dedicated Partner Routes                                      │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  LAYER 4: Data Security                                                  │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │ • AWS Secrets Manager (credentials)                             │    │
│  │ • Jasypt Encrypted Properties                                   │    │
│  │ • No Hardcoded Credentials                                      │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Quick Reference

### Service Route Mapping by Domain

| Domain | Route Prefix | Service |
|--------|--------------|---------|
| **Platform** | `/api/v*/auth/**` | multi-tenant-auth |
| **Platform** | `/ac/**` | accounting-service |
| **Platform** | `/notification/**` | notification |
| **Platform** | `/janus/**` | janus |
| **Platform** | `/risk/**` | risk |
| **Platform** | `/rule-engine/**` | rule-engine |
| **Platform** | `/golden-gate/**` | golden-gate |
| **Platform** | `/panacea/**` | panacea |
| **Payments** | `/payments/**` | payments |
| **Payments** | `/banking/**` | banking |
| **Payments** | `/edc-adapter/**` | edc-adapter |
| **Payments** | `/miniatm/**` | miniatm-backend |
| **Payments** | `/payments-mweb/**` | payments-mweb |
| **Lending** | `/los/**` | los-lender |
| **Lending** | `/los-web/**` | los-web |
| **Lending** | `/merchant-onboarding/**` | fs-bnpl-service |
| **Lending** | `/lmsclient/**` | lms-client |
| **BAU** | `/finpro/**` | finpro |
| **BAU** | `/tokoko/**` | tokoko-service |
| **BAU** | `/loyalty/**` | loyalty |
| **BAU** | `/rafana/**` | rafana |
| **BAU** | `/bukupay/retail/**` | retail-backend |
| **Data & Analytics** | `/dracula-v2/**` | dracula-v2 |
| **Data & Analytics** | `/data-analytics/**` | data-analytics |
| **Data & Analytics** | `/transaction-history/**` | transaction-history |

### Domain Summary

| Domain | Services | Key Responsibility |
|--------|----------|-------------------|
| **Platform** | 10 services | Foundation: auth, identity, risk, rules, accounting, notifications, payment portal |
| **Payments** | 8 services | Payment processing, banking, terminal transactions, disbursements |
| **Lending** | 4 services | Loan origination, BNPL, credit management |
| **BAU** | 6 services | Digital products, e-commerce, loyalty, partners |
| **Data & Analytics** | 3 services | Event streaming, analytics, transaction history |

### Key Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| **Microservices (34 services)** | Independent deployment, scaling, and team ownership |
| **5-Domain Organization** | Clear ownership: Platform, Payments, Lending, BAU, Data & Analytics |
| **Event-Driven (Kafka)** | Async communication, eventual consistency, high throughput |
| **Reactive (WebFlux)** | Non-blocking I/O for high-concurrency services |
| **Hexagonal Architecture** | Separation of domain logic from infrastructure |
| **Cloud-Native** | Containerized, Kubernetes-ready, AWS deployment |
| **API-First** | OpenAPI/Swagger specifications drive development |
| **Centralized Config** | Spring Cloud Config for environment management |

---

## Documentation Validity

The **Doc Reference** column in each service table contains a commit ID linking to the specific commit in the service's repository that this documentation reflects. Use these references to:

- **Track documentation freshness**: Compare the linked commit with the current HEAD to see how much has changed
- **Audit documentation accuracy**: Review changes since the documented commit to identify potential documentation gaps
- **Update documentation**: When updating this document, fetch the latest commit ID from each service repository

Services marked with `-` in the Doc Reference column either:
- Have repositories that were not accessible at the time of documentation
- Use different repository naming conventions

---

*Last updated: 2026-01-27*
