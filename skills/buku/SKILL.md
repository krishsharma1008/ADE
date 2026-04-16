---
name: buku
description: >
  BukuWarung lending tribe organizational context. 34 microservices across 5 domains
  (Platform, Payments, Lending, BAU, Data). Use when you need to understand BUKU's
  architecture, identify which services are affected by a task, discover service
  dependencies, or route work to the correct domain. Routes to buku-code-development
  for coding tasks and buku-rfc-generation for RFC/design tasks. Do NOT use for
  actual code implementation or RFC writing — use the sub-skills instead.
---

# BukuWarung Knowledge Base

> **Before every `git push` on a BUKU repo**, run the Pre-Push Check in
> `buku-code-development/SKILL.md` → "Pre-Push Check (MANDATORY before every push)".
> At minimum: `spotlessApply`, `clean compileJava compileTestJava check`, every
> loader/variant `compileJava*` task, and the repo's test + static-check tasks.
> Fix root causes; never push with `--no-verify` or by disabling failing checks.

## Select Your Workflow

| Task | Skill | When to Use |
|------|-------|-------------|
| **Generate RFC from PRD** | `buku-rfc-generation` | Given a PRD, create a technical RFC document |
| **Develop Features** | `buku-code-development` | Write code, implement features, fix bugs |

---

## Quick Task Router

**"Generate an RFC for..."** or **"Create a technical design for..."**
→ Use the `buku-rfc-generation` skill

**"Implement..."** or **"Add feature..."** or **"Fix bug..."** or **"Write code for..."**
→ Use the `buku-code-development` skill

**"Explain the architecture..."** or **"How does X service work?"**
→ Read `references/architecture.md` directly

---

## Documentation Index

### Core Architecture
| File | Purpose |
|------|---------|
| `references/architecture.md` | System overview, 34 services, domains, dependencies |
| `references/gateway-routes.md` | API routes and gateway configuration |
| `references/services/{service-name}.md` | Per-service documentation (32 services) |

### RFC Generation (via `buku-rfc-generation` skill)
| File | Purpose |
|------|---------|
| `references/rfc-guidelines.md` | Section-by-section RFC guidance |
| `references/rfc-template.md` | RFC document structure |

### Code Development (via `buku-code-development` skill)
| File | Purpose |
|------|---------|
| `references/patterns.md` | Auth, error handling, Kafka, database patterns |
| `references/code-conventions.md` | Project structure, naming, code standards |
| `references/code-examples.md` | Copy-paste code templates |

---

## Lending Tribe Repos

The three active Java repos for the lending domain:

| Repo | Service | Stack |
|------|---------|-------|
| `bizfund-main` | los-lender (Loan Origination System) | Java 11, Spring Boot 2.6, Gradle, Hexagonal |
| `fs-bnpl-service-main` | fs-bnpl-service (Buy Now Pay Later) | Java 11, Spring Boot 2.6, Gradle, Hexagonal |
| `fs-brick-service-main` | fs-brick-service (Partner Integration Layer) | Java 11, Spring Boot 2.6, Gradle, Hexagonal |

Frontend: `merchant-bnpl-app` — Next.js 14, React 18, TypeScript 5, TailwindCSS

External Partners: **Veefin** (LMS APIs, BNPL APIs), **Brick** (partner integration layer), **VIDA** (KYC)

---

## Domain Overview

| Domain | Services | Responsibility |
|--------|----------|----------------|
| **Platform** | multi-tenant-auth, notification, janus, risk, rule-engine, accounting-service | Auth, KYC, notifications, risk |
| **Payments** | payments, banking, edc-adapter, miniatm-backend | Payment processing, banking |
| **Lending** | los-lender, fs-bnpl-service, lms-client | Loans, BNPL |
| **BAU** | finpro, tokoko-service, loyalty, retail-backend | Digital products, e-commerce |
| **Data** | dracula-v2, data-analytics, transaction-history | Events, analytics |

---

## Service Discovery

| If task involves... | Check these services |
|---------------------|----------------------|
| Login, auth, OTP | multi-tenant-auth, notification |
| Payments, VA, disbursement | payments, banking, accounting-service |
| KYC, identity | janus, kyc-liveliness, user-trust |
| Loans, credit, BNPL | los-lender, fs-bnpl-service, lms-client, risk |
| Pulsa, bills, PPOB | finpro, digital-product-adapter |
| E-commerce, orders | tokoko-service |
| Rewards, points | loyalty |
| EDC, terminals | edc-adapter, miniatm-backend |
| QRIS, retail | retail-backend |
| Rules, routing | rule-engine |
| Analytics, reporting | dracula-v2, data-analytics, transaction-history |

Read `references/services/{service-name}.md` for per-service details.
Read `references/architecture.md` for full system architecture and dependencies.
