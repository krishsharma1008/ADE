# Reasoning

## Why Each Decision Was Made

This document explains the reasoning behind every architectural and implementation decision for Ticket 1 (BNPL service) and Ticket 2 (Brick service), tracing each back to the existing Java codebase patterns.

---

## 1. Why Java Spring Boot (Not Next.js All-in-One)

**Previous approach**: A unified Next.js 14 app served as both backend and frontend.

**Why the pivot**: The user explicitly requested sticking to the original architecture for the backend. The existing repos (`fs-bnpl-service-main`, `fs-brick-service-main`) have established patterns, team familiarity, and production deployment pipelines. Introducing a new tech stack for the backend would:
- Require rewriting all existing integrations
- Break existing CI/CD and monitoring
- Create a maintenance burden with two different backend stacks
- Lose the battle-tested EventAuditUtil, partner signature auth, and circuit breaker patterns

**Decision**: Build on top of existing Java repos. Create a separate Next.js frontend-only app for validation/demo purposes.

---

## 2. Why Separate BNPL and Brick Endpoints (Not a Single Service)

**Source basis**: The existing architecture has clear service boundaries — Brick is the external-facing partner integration layer, BNPL is the internal business logic layer.

**Reasoning**:
- **Brick service** receives requests from external partners (Veefin) with partner signature authentication
- **BNPL service** stores and processes merchant data with LOS token authentication
- Brick calls BNPL via `FsBnplPort`/`FsBnplAdapter` using REST
- This separation allows Brick to add audit trails, idempotency, and retry logic without coupling to BNPL's business logic
- Following the existing pattern prevents breaking the established service mesh

**Flow**: `Veefin → Brick Controller (4-step audit) → Brick Service (partner audit) → FsBnplAdapter → BNPL Controller → BNPL Service → Database`

---

## 3. Why New `application_document` Table (Not Reusing `merchant_uploads`)

**Source basis**: `MerchantUploadsEntity` is tightly coupled to `MerchantDataEntity` via `@ManyToOne` with `cascade = CascadeType.ALL`. It uses auto-generated `Long` IDs and has pre-signed URL fields specific to the merchant self-upload flow.

**Reasoning**:
- Partner-uploaded documents (via Brick) have a different lifecycle than merchant self-uploads
- The existing `merchant_uploads` table has fields irrelevant to partner uploads (`preSignedUrl`, `prevS3Path`)
- A new `application_document` table with UUID PKs matches the Brick service entity pattern
- Keeps the partner upload flow independent — changes to one don't affect the other
- Foreign key to `merchant_data(merchant_id)` maintains referential integrity

---

## 4. Why `ResponseEntity<?>` (Not `ResponseDto<T>`) for BNPL Inter-Service Endpoints

**Source basis**: `MerchantEnrichmentController` returns `ResponseEntity<?>` directly for endpoints called by Brick. `MerchantOnboardingController` returns `ResponseEntity<ResponseDto<T>>` for Firebase-authenticated frontend endpoints.

**Reasoning**:
- The `FsBnplAdapter` uses `RestTemplateService.executeServiceCall()` which deserializes the response body directly into the target class (e.g., `MerchantIdentityDto.class`, `EnrichmentDataResponse.class`)
- If the BNPL endpoint wrapped the response in `ResponseDto`, the adapter would need to unwrap it — adding complexity
- Existing inter-service endpoints (`/merchant/identity`, `/merchant/enrichment-data/inquiry`) return objects directly
- The `ResponseDto` wrapper is for frontend consumption (with `status`, `message`, `data` fields)
- For inter-service calls, the raw object is simpler and follows established convention

---

## 5. Why `WAITING_FOR_REVIEW` (Not a New `SUBMITTED` Status)

**Source basis**: `MerchantStatus.java` has 16 existing enum values. There is no `SUBMITTED` status. The natural transition after document upload + submission is `WAITING_FOR_REVIEW`.

**Reasoning**:
- Adding a new enum value to `MerchantStatus` would require database migration on the BNPL side (if the column is `VARCHAR` it's safe, but the Java enum must match)
- `WAITING_FOR_REVIEW` already semantically means "application submitted and pending verification"
- The existing onboarding flow uses this status after merchant registration
- The Java service's `MerchantRegistrationStatus` maps `WAITING_FOR_REVIEW` to `"awaiting_verification"` which is the correct partner-facing status
- Reusing existing statuses prevents downstream breakage in LOS, reporting, and notification systems

---

## 6. Why the 4-Step Audit Pattern (Not Simpler Logging)

**Source basis**: `EventAuditUtil.java` is used by every Brick controller. The `BorrowerDataIntegrationController` shows the exact pattern.

**Reasoning**:
- **Idempotency** — `startServiceEventAudit()` checks if a request was already processed. If status is `SUCCESS`, return cached response. This prevents duplicate processing of partner requests.
- **Two-level tracking** — Service-level audit (controller) tracks the overall request. Partner-level audit (service) tracks the BNPL call. This gives visibility into where failures occur.
- **Retry safety** — If a request fails, `retryCount` is incremented. Only `FAILED` requests can be retried. `IN_PROGRESS` requests throw `IllegalStateException` (preventing concurrent processing).
- **Compliance** — Every partner interaction is recorded with request/response payloads for audit trails.
- Simple logging would miss idempotency, retry tracking, and the ability to replay failed requests.

---

## 7. Why Flyway for Brick Service (Previously No Migration Tool)

**Source basis**: BNPL service uses Flyway (`spring.flyway.enabled=true`, `classpath:schema`). Bizfund service uses Flyway (`db/migration/schema/`). Brick service had no migration tool.

**Reasoning**:
- Brick service will need database schema changes as new features are added
- Flyway is already used by the other services in the ecosystem — consistent tooling
- A baseline migration (`V1__Add_Flyway_Baseline.sql`) establishes version history without changing existing schema
- Configuration follows Spring Boot Flyway conventions (`spring.flyway.locations=classpath:db/migration`)
- `out-of-order=true` allows parallel development branches to add migrations without version conflicts

---

## 8. Why Partner Signature Path Patterns (Not Open Endpoints)

**Source basis**: `application.yml` has `partner.signature.partners.veefin.path-patterns` that lists all endpoints requiring Veefin partner signature authentication.

**Reasoning**:
- The partner signature filter validates HMAC-based signatures on incoming requests
- Without this, anyone could call the Brick endpoints directly, bypassing authentication
- Adding `/fs/brick/service/application/v1/**` to the path patterns ensures all new application endpoints require valid Veefin signatures
- The wildcard pattern covers all three endpoints (document upload, update, submit) and future additions

---

## 9. Why Constructor Injection in Brick (Field Injection in BNPL)

**Source basis**: Brick controllers use `@RequiredArgsConstructor` (constructor injection). BNPL controllers use `@Autowired` (field injection).

**Reasoning**: **Match each service's existing convention exactly.** The user explicitly requested following the existing coding style. While constructor injection is generally considered better practice (testable, immutable), mixing styles within a single service would create inconsistency. Each service's tests are also designed around its DI style:
- Brick tests use `MockMvcBuilders.standaloneSetup(controller)` with `new Controller(mockService, mockAudit, objectMapper)`
- BNPL tests use `@WebMvcTest` with `@MockBean` for service dependencies

---

## 10. Why Partial Updates in `updateApplication` (Not Full Replace)

**Source basis**: The existing `MerchantOnboardingServiceImpl` updates individual fields conditionally.

**Reasoning**:
- Partners may only want to update specific fields (e.g., just the email or bank details)
- A full replace would require the partner to send ALL fields, even unchanged ones
- Using `StringUtils.isNotBlank(field)` checks means only non-null, non-empty fields are updated
- This matches the PATCH semantics commonly used in REST APIs
- Prevents accidental data loss if a partner omits a field in the update request

---

## 11. Why Separate Request/Response Models in Brick (Mirroring BNPL DTOs)

**Source basis**: Brick service `model/bnpl/` package mirrors BNPL service models but under a different package.

**Reasoning**:
- Brick and BNPL are separate services with separate classpaths — they can't share Java classes directly
- The Brick models mirror BNPL DTOs because Brick proxies requests to BNPL
- Keeping them separate allows each service to evolve its models independently
- If BNPL adds a field, Brick can add it to its model when ready (not forced to update simultaneously)
- The `FsBnplAdapter` serializes Brick models to JSON and BNPL deserializes into its own DTOs — the JSON contract is the shared interface

---

## 12. Summary: File-to-Purpose Mapping

### BNPL Service (fs-bnpl-service-main) — New Files
| File | Purpose |
|------|---------|
| `dto/DocumentUploadRequestDto.java` | Request DTO for partner document upload |
| `dto/DocumentUploadResponseDto.java` | Response DTO for partner document upload |
| `dto/UpdateApplicationRequestDto.java` | Request DTO for application update |
| `dto/UpdateApplicationResponseDto.java` | Response DTO for application update |
| `dto/SubmitApplicationRequestDto.java` | Request DTO for application submission |
| `dto/SubmitApplicationResponseDto.java` | Response DTO for application submission |
| `enums/ApplicationDocumentType.java` | Document type enum (KTP, SELFIE, etc.) |
| `entity/ApplicationDocumentEntity.java` | JPA entity for partner-uploaded documents |
| `repository/ApplicationDocumentRepository.java` | Spring Data JPA repository |
| `service/ApplicationService.java` | Service interface |
| `service/impl/ApplicationServiceImpl.java` | Service implementation |
| `controller/ApplicationController.java` | REST controller (3 endpoints) |
| `resources/schema/V2__Add_Application_Documents_Table.sql` | Flyway migration |

### Brick Service (fs-brick-service-main) — New/Modified Files
| File | Purpose |
|------|---------|
| `model/application/*.java` (6 files) | Request/response models for 3 operations |
| `provider/FsBnplPort.java` | **Modified** — added 3 new method signatures |
| `provider/impl/FsBnplAdapter.java` | **Modified** — added 3 new implementations |
| `service/ApplicationIntegrationService.java` | Service interface |
| `service/impl/ApplicationIntegrationServiceImpl.java` | Service impl with partner-level audit |
| `controller/ApplicationIntegrationController.java` | REST controller with 4-step audit |
| `resources/application.yml` | **Modified** — added Flyway config + partner paths |
| `resources/db/migration/V1__Add_Flyway_Baseline.sql` | Baseline Flyway migration |
