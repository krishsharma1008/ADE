# App Gateway Downstream Services

This document lists all downstream services that the **app-gateway** (Spring Cloud Gateway) routes traffic to.

## Overview

The app-gateway serves as the central API gateway for BukuWarung's backend services, handling routing, authentication (Firebase), rate limiting, and request filtering.

**Repository:** [bukuwarung/app-gateway](https://github.com/bukuwarung/app-gateway)

---

## Downstream Services

| # | Service Name | Route Prefix | GitHub Repository |
|---|-------------|--------------|-------------------|
| 1 | **notification-service** | `/notification/**`, `/api/notification/**` | [bukuwarung/notification](https://github.com/bukuwarung/notification) |
| 2 | **panacea** | `/panacea/**` | [bukuwarung/panacea](https://github.com/bukuwarung/panacea) |
| 3 | **golden-gate-service** | `/golden-gate/**` | [bukuwarung/golden-gate](https://github.com/bukuwarung/golden-gate) |
| 4 | **auth-service** | `/api/v1/auth/**`, `/api/v2/auth/**`, `/api/v3/auth/**`, `/ops/v1/auth/**` | [bukuwarung/multi-tenant-auth](https://github.com/bukuwarung/multi-tenant-auth) |
| 5 | **los-service** | `/los/**` | [bukuwarung/los-lender](https://github.com/bukuwarung/los-lender) |
| 6 | **los-web-service** | `/los-web/**` | [bukuwarung/los-web](https://github.com/bukuwarung/los-web) |
| 7 | **payments-service** | `/payments/**`, `/api/payments/**`, `/docs/payments/**`, `/webhooks/payments/**` | [bukuwarung/payments](https://github.com/bukuwarung/payments) |
| 8 | **finpro-service** | `/finpro/**` | [bukuwarung/finpro](https://github.com/bukuwarung/finpro) |
| 9 | **janus-service** | `/janus/**` | [bukuwarung/janus](https://github.com/bukuwarung/janus) |
| 10 | **payments-mweb** | `/payments-mweb/**` | [bukuwarung/payments-mweb](https://github.com/bukuwarung/payments-mweb) |
| 11 | **risk-service** | `/risk/**` | [bukuwarung/risk](https://github.com/bukuwarung/risk) |
| 12 | **rule-engine** | `/rule-engine/**` | [bukuwarung/rule-engine](https://github.com/bukuwarung/rule-engine) |
| 13 | **digital-product-service** | `/digital-products/external/**` | [bukuwarung/digital-product-adapter](https://github.com/bukuwarung/digital-product-adapter) |
| 14 | **payments-config-server** | `/payments-config-server/**` | [bukuwarung/payments-config-server](https://github.com/bukuwarung/payments-config-server) |
| 15 | **accounting-service** | `/ac/**`, `/b2b/supplier/**` | [bukuwarung/accounting-service](https://github.com/bukuwarung/accounting-service) |
| 16 | **loyalty-service** | `/loyalty/**` | [bukuwarung/loyalty](https://github.com/bukuwarung/loyalty) |
| 17 | **data-analytics-service** | `/data-analytics/**` | [bukuwarung/data-analytics](https://github.com/bukuwarung/data-analytics) |
| 18 | **fs-bnpl-service** | `/merchant-onboarding/**` | [bukuwarung/fs-bnpl-service](https://github.com/bukuwarung/fs-bnpl-service) |
| 19 | **lms-client** | `/lmsclient/**` | [bukuwarung/lms-client](https://github.com/bukuwarung/lms-client) |
| 20 | **fs-brick-service** | `/fs/brick/service/**` | [bukuwarung/fs-brick-service](https://github.com/bukuwarung/fs-brick-service) |
| 21 | **fs-dashboard-service** | `/fs-dashboard/**` | [bukuwarung/fs-dashboard-service](https://github.com/bukuwarung/fs-dashboard-service) |
| 22 | **kycliveliness-service** | `/kycliveliness/webhooks/vida/status` | [bukuwarung/kyc-liveliness](https://github.com/bukuwarung/kyc-liveliness) |
| 23 | **tokoko-service** | `/tokoko/shipper/**`, `/b2b/invoice/**`, `/tokoko/admin/api/invoice` | [bukuwarung/tokoko-service](https://github.com/bukuwarung/tokoko-service) |
| 24 | **transaction-history-service** | `/transaction-history/**` | [bukuwarung/transaction-history](https://github.com/bukuwarung/transaction-history) |
| 25 | **banking-service** | `/banking/services/**` | [bukuwarung/banking](https://github.com/bukuwarung/banking) |
| 26 | **banking-batch-service** | `/banking/batch/**` | [bukuwarung/banking-batch](https://github.com/bukuwarung/banking-batch) |
| 27 | **mxg-mweb-service** | `/mx-mweb/**` | *Repository not found* |
| 28 | **user-trust-service** | `/user-trust/**` | [bukuwarung/user-trust](https://github.com/bukuwarung/user-trust) |
| 29 | **rafana-service** | `/rafana/**`, `/rafana/partner/**` | [bukuwarung/rafana-wrapper](https://github.com/bukuwarung/rafana-wrapper) |
| 30 | **rafana-sandbox-service** | `/rafana-sandbox/**`, `/rafana-sandbox/partner/**` | [bukuwarung/rafana-wrapper](https://github.com/bukuwarung/rafana-wrapper) |
| 31 | **edc-adapter-service** | `/edc-adapter/**` | [bukuwarung/edc-adapter](https://github.com/bukuwarung/edc-adapter) |
| 32 | **miniatm-service** | `/miniatm/**`, `/miniatm/ops/**` | [bukuwarung/miniatm-backend](https://github.com/bukuwarung/miniatm-backend) |
| 33 | **retail-service** | `/bukupay/retail/**` | [bukuwarung/retail-backend](https://github.com/bukuwarung/retail-backend) |
| 34 | **dracula-v2-service** | `/dracula-v2/**` | [bukuwarung/dracula-v2](https://github.com/bukuwarung/dracula-v2) |

---

## Service Details

### Core Services

| Service | Description | Repository |
|---------|-------------|------------|
| **auth-service** | Multi-tenant authentication service (OTP, login, user management) | [multi-tenant-auth](https://github.com/bukuwarung/multi-tenant-auth) |
| **payments-service** | Payment processing, disbursements, virtual accounts | [payments](https://github.com/bukuwarung/payments) |
| **accounting-service** | Core business and transaction management | [accounting-service](https://github.com/bukuwarung/accounting-service) |
| **finpro-service** | Digital products (PPOB, PaymentIn, PaymentOut) | [finpro](https://github.com/bukuwarung/finpro) |

### KYC/Identity Services

| Service | Description | Repository |
|---------|-------------|------------|
| **janus-service** | KYC/KYB verification (KTP OCR, face matching, liveliness) | [janus](https://github.com/bukuwarung/janus) |
| **kycliveliness-service** | VIDA integration for passive liveliness | [kyc-liveliness](https://github.com/bukuwarung/kyc-liveliness) |
| **user-trust-service** | User trust/fraud detection | [user-trust](https://github.com/bukuwarung/user-trust) |

### Lending Services

| Service | Description | Repository |
|---------|-------------|------------|
| **los-service** | Loan Origination System | [los-lender](https://github.com/bukuwarung/los-lender) |
| **los-web-service** | LOS Web frontend | [los-web](https://github.com/bukuwarung/los-web) |
| **fs-bnpl-service** | Buy Now Pay Later / Merchant onboarding | [fs-bnpl-service](https://github.com/bukuwarung/fs-bnpl-service) |
| **lms-client** | Loan Management System (Hypercore integration) | [lms-client](https://github.com/bukuwarung/lms-client) |

### Banking Services

| Service | Description | Repository |
|---------|-------------|------------|
| **banking-service** | Banking operations | [banking](https://github.com/bukuwarung/banking) |
| **banking-batch-service** | Banking batch operations | [banking-batch](https://github.com/bukuwarung/banking-batch) |
| **golden-gate-service** | Payment portal backend | [golden-gate](https://github.com/bukuwarung/golden-gate) |

### Partner/External Services

| Service | Description | Repository |
|---------|-------------|------------|
| **rafana-service** | Rafana B2B service | [rafana-wrapper](https://github.com/bukuwarung/rafana-wrapper) |
| **edc-adapter** | EDC terminal middleware adapter | [edc-adapter](https://github.com/bukuwarung/edc-adapter) |
| **miniatm-service** | Mini ATM backend | [miniatm-backend](https://github.com/bukuwarung/miniatm-backend) |
| **retail-service** | BukuPay Retail (QRIS transactions) | [retail-backend](https://github.com/bukuwarung/retail-backend) |

### Other Services

| Service | Description | Repository |
|---------|-------------|------------|
| **notification-service** | SMS/WA/Slack/Email/Push notifications | [notification](https://github.com/bukuwarung/notification) |
| **tokoko-service** | Tokoko e-commerce | [tokoko-service](https://github.com/bukuwarung/tokoko-service) |
| **loyalty-service** | Loyalty rewards | [loyalty](https://github.com/bukuwarung/loyalty) |
| **data-analytics-service** | Data analytics | [data-analytics](https://github.com/bukuwarung/data-analytics) |
| **risk-service** | Risk assessment | [risk](https://github.com/bukuwarung/risk) |
| **rule-engine** | Business rules engine | [rule-engine](https://github.com/bukuwarung/rule-engine) |
| **transaction-history-service** | Transaction history | [transaction-history](https://github.com/bukuwarung/transaction-history) |
| **dracula-v2-service** | Kafka data consumer | [dracula-v2](https://github.com/bukuwarung/dracula-v2) |

### Web Frontends

| Service | Description | Repository |
|---------|-------------|------------|
| **panacea** | Payment portal web UI | [panacea](https://github.com/bukuwarung/panacea) |
| **payments-mweb** | Payments mobile web | [payments-mweb](https://github.com/bukuwarung/payments-mweb) |

---

## Partnership Routes

The gateway also provides dedicated routes for external partners with path rewriting:

### MiniATM Partnership (`/miniatm-pro/**`)
Routes for `BUKU_ORIGIN: ext-miniatm-partner`:

| Route | Downstream Service | Repository |
|-------|-------------------|------------|
| `/miniatm-pro/api/v1/auth/**` | auth-service | [multi-tenant-auth](https://github.com/bukuwarung/multi-tenant-auth) |
| `/miniatm-pro/ac/api/**` | accounting-service | [accounting-service](https://github.com/bukuwarung/accounting-service) |
| `/miniatm-pro/janus/api/**` | janus-service | [janus](https://github.com/bukuwarung/janus) |
| `/miniatm-pro/finpro/api/saldo` | finpro-service | [finpro](https://github.com/bukuwarung/finpro) |
| `/miniatm-pro/*/payments/**` | payments-service | [payments](https://github.com/bukuwarung/payments) |
| `/miniatm-pro/edc-adapter/**` | edc-adapter-service | [edc-adapter](https://github.com/bukuwarung/edc-adapter) |

### Nusacita Partnership (`/nusacita/**`)
Routes for `BUKU_ORIGIN: ext-nusacita-partner`:

| Route | Downstream Service | Repository |
|-------|-------------------|------------|
| `/nusacita/api/v1/auth/**` | auth-service | [multi-tenant-auth](https://github.com/bukuwarung/multi-tenant-auth) |
| `/nusacita/ac/api/**` | accounting-service | [accounting-service](https://github.com/bukuwarung/accounting-service) |
| `/nusacita/janus/api/**` | janus-service | [janus](https://github.com/bukuwarung/janus) |
| `/nusacita/finpro/api/saldo` | finpro-service | [finpro](https://github.com/bukuwarung/finpro) |
| `/nusacita/*/payments/**` | payments-service | [payments](https://github.com/bukuwarung/payments) |
| `/nusacita/edc-adapter/**` | edc-adapter-service | [edc-adapter](https://github.com/bukuwarung/edc-adapter) |

### BukuPay Retail (`/bukupay/**`)
Routes for `BUKU_ORIGIN: bukupay-retail`:

| Route | Downstream Service | Repository |
|-------|-------------------|------------|
| `/bukupay/api/v1/auth/**` | auth-service | [multi-tenant-auth](https://github.com/bukuwarung/multi-tenant-auth) |
| `/bukupay/ac/api/**` | accounting-service | [accounting-service](https://github.com/bukuwarung/accounting-service) |
| `/bukupay/*/payments/**` | payments-service | [payments](https://github.com/bukuwarung/payments) |
| `/bukupay/janus/**` | janus-service | [janus](https://github.com/bukuwarung/janus) |
| `/bukupay/retail/api/**` | retail-service | [retail-backend](https://github.com/bukuwarung/retail-backend) |
| `/bukupay/retail/webhook/**` | retail-service (no auth) | [retail-backend](https://github.com/bukuwarung/retail-backend) |
| `/bukupay/retail/ops/**` | retail-service (internal) | [retail-backend](https://github.com/bukuwarung/retail-backend) |

---

## Authentication Methods

| Method | Services |
|--------|----------|
| **Firebase Auth** | golden-gate, auth-service, los, fs-bnpl, tokoko, rafana, edc-adapter, miniatm, dracula-v2 |
| **Signature Auth** | rafana/partner endpoints, rafana-sandbox/partner endpoints |
| **Request Integrity** | payments disbursements (for BukuWarung app) |
| **No Auth** | notification, panacea, payments webhooks, retail webhooks |

---

## Rate Limiting

Several endpoints have Redis-based rate limiting configured:
- Auth bacon endpoints (deprecated APK)
- OTP send/verify endpoints
- Login endpoints
- Janus liveliness checks
- Banking services
- Rafana sandbox endpoints

---

## Environment Variables

| Service | Environment Variable |
|---------|---------------------|
| notification | `NOTIFICATION_SERVICE_URL` |
| panacea | `PANACEA_WEB_URL` |
| golden-gate | `GOLDEN_GATE_SERVICE_URL` |
| auth | `MULTI_TENENT_AUTH_SERVICE_URL` |
| los | `LOS_SERVICE_URL` |
| los-web | `LOS_WEB_SERVICE_URL` |
| payments | `PAYMENT_SERVICE_URL` |
| finpro | `FINPRO_SERVICE_URL` |
| janus | `JANUS_SERVICE_URL` |
| payments-mweb | `PAYMENTS_MWEB_URL` |
| risk | `RISK_SERVICE_URL` |
| rule-engine | `RULE_ENGINE_SERVICE_URL` |
| digital-product | `DIGITAL_PRODUCT_URL` |
| payments-config | `PAYMENTS_CONFIG_SERVER_URL` |
| accounting | `ACCOUNTING_SERVICE_URL` |
| loyalty | `LOYALTY_SERVICE_URL` |
| data-analytics | `DATA_ANALYTICS_SERVICE_URL` |
| fs-bnpl | `MERCHANT_ONBOARDING_SERVICE_URL` |
| lms-client | `LMS_CLIENT_SERVICE_URL` |
| fs-brick | `BRICK_CONNECTOR_SERVICE_URL` |
| fs-dashboard | `FS_DASHBOARD_SERVICE_URL` |
| kycliveliness | `KYCLIVELINESS_SERVICE_URL` |
| tokoko | `TOKOKO_SERVICE_URL` |
| transaction-history | `TRANSACTION_HISTORY_SERVICE_URL` |
| banking | `BANKING_SERVICE_URL` |
| banking-batch | `BANKING_BATCH_SERVICE_URL` |
| mxg-mweb | `MXG_MWEB_SERVICE_URL` |
| user-trust | `USER_TRUST_SERVICE_URL` |
| rafana | `RAFANA_SERVICE_URL` |
| rafana-sandbox | `RAFANA_SANDBOX_SERVICE_URL` |
| edc-adapter | `EDC_ADAPTER_SERVICE_URL` |
| miniatm | `MINIATM_SERVICE_URL` |
| retail | `RETAIL_SERVICE_URL` |
| dracula-v2 | `DRACULA_V2_SERVICE_URL` |

---

*Last updated: January 2026*
