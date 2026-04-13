# Implementation Best Practices

## Ticket 1: Integrate Brick Endpoints on BNPL Service
## Ticket 2: Define Endpoints on Brick Service for Document Upload, Update Application & Submit Application

**Architecture**: Java 11 + Spring Boot 2.6.3 (changes on top of existing `fs-bnpl-service-main` and `fs-brick-service-main` repos)

---

## 1. Codebase Analysis Before Implementation

### What Worked
- **Deep exploration of both Java repos first** — read every controller, service, entity, enum, config, and test file before writing a single line. This prevented mismatches in naming, patterns, and conventions.
- **Pattern extraction** — identified the exact patterns to replicate:
  - BNPL: `@Autowired` field injection, `@Validated`, `ResponseEntity<?>` returns, `@Tag`/`@Operation`/`@SecurityRequirement` Swagger annotations
  - Brick: `@RequiredArgsConstructor` constructor injection, `@RequestAttribute("x-request-id")`, 4-step audit pattern, MDC logging
- **Enum verification** — discovered `MerchantStatus` has no `SUBMITTED` value. The correct status for submission is `WAITING_FOR_REVIEW`. This would have caused a compile error if not caught early.

### Steps
1. Read all controllers in both services to understand DI style and response patterns
2. Read all entities to understand JPA annotations and JSONB usage
3. Read `EventAuditUtil` thoroughly — it's the most critical pattern in Brick service
4. Read existing tests to match test framework patterns (`@WebMvcTest` vs `@ExtendWith(MockitoExtension.class)`)
5. Read `application.yml` / `application.properties` for config patterns (Flyway, partner signatures)
6. Check inter-service communication via `FsBnplPort` / `FsBnplAdapter` / `RestTemplateService`

---

## 2. BNPL Service Implementation (Ticket 1)

### DTOs
- **Follow existing DTO naming** — `{Action}{Object}RequestDto.java` / `{Action}{Object}ResponseDto.java`
- **Flat package** — DTOs go in `com.bukuwarung.fsbnplservice.dto` (not sub-packages), matching existing convention
- **Validation annotations** — `@NotBlank` on required fields, matching Java Bean Validation pattern
- **Lombok** — `@Data @Builder @NoArgsConstructor @AllArgsConstructor` on all DTOs

### Entity
- **ApplicationDocumentEntity** — new entity for partner-uploaded documents (separate from existing `MerchantUploadsEntity` which is for merchant self-uploads)
- **UUID primary key** — matches existing entity pattern (`@Id private UUID id`)
- **Timestamps** — `@CreationTimestamp @Temporal(TemporalType.TIMESTAMP)` on `createdAt`/`updatedAt`
- **`@Setter @Getter` instead of `@Data`** — matches `MerchantDataEntity` pattern (BNPL entities use `@Setter @Getter`, not `@Data`)

### Repository
- **Standard Spring Data JPA** — extend `JpaRepository<ApplicationDocumentEntity, UUID>`
- **Query methods** — `findByMerchantId()`, `findByMerchantIdAndDocumentType()`

### Service
- **Interface + Impl pattern** — `ApplicationService` interface in `service/`, `ApplicationServiceImpl` in `service/impl/`
- **`@Autowired` field injection** — matches BNPL service convention (not constructor injection)
- **`@Transactional`** on write methods
- **Partial updates** — use `StringUtils.isNotBlank()` to only update non-null fields

### Controller
- **Return `ResponseEntity<?>`** — for inter-service endpoints (called by Brick), return objects directly without `ResponseDto` wrapping. This matches `MerchantEnrichmentController` pattern.
- **Authentication** — `@SecurityRequirement(name = AuthConstant.LOS_AUTH_TOKEN)` for LOS/Brick-facing endpoints
- **Error handling** — catch `IllegalArgumentException` → 400, catch `Exception` → 500

### Flyway Migration
- **File naming** — `V2__Add_Application_Documents_Table.sql` (V2 since V1 already exists)
- **Location** — `src/main/resources/schema/` (matches existing `classpath:schema` config)
- **Foreign key** — `REFERENCES merchant_data(merchant_id)` linking to existing table
- **Indexes** — on `merchant_id` and `document_type` for query performance

### Steps
1. Create 6 DTOs (DocumentUpload/UpdateApplication/SubmitApplication request+response)
2. Create `ApplicationDocumentType` enum
3. Create `ApplicationDocumentEntity` with JPA annotations
4. Create `ApplicationDocumentRepository`
5. Create `ApplicationService` interface
6. Create `ApplicationServiceImpl` with `@Transactional` methods
7. Create `ApplicationController` with 3 endpoints
8. Create Flyway migration `V2__Add_Application_Documents_Table.sql`
9. Write unit tests (controller + service) with 100% coverage

---

## 3. Brick Service Implementation (Ticket 2)

### Models
- **Package** — `model/application/` sub-package (matches existing `model/bnpl/`, `model/borrower/`)
- **Same fields as BNPL DTOs** — the Brick models mirror BNPL DTOs since Brick proxies to BNPL

### FsBnplPort / FsBnplAdapter Updates
- **3 new methods** added to `FsBnplPort` interface:
  - `uploadApplicationDocument(DocumentUploadRequest)`
  - `updateApplication(UpdateApplicationRequest)`
  - `submitApplication(SubmitApplicationRequest)`
- **Adapter implementation** follows existing pattern:
  - `UriComponentsBuilder.fromUriString(baseUrl).path("/application/...").encode().toUriString()`
  - `restTemplateService.executeServiceCall(url, method, "los-auth-token", fsBnplToken, request, requestName, ResponseClass.class, null)`
  - Null response check → throw `RuntimeException`

### Service
- **`ApplicationIntegrationService`** — interface with 3 methods, each taking request + requestId
- **`ApplicationIntegrationServiceImpl`** — handles **partner-level audit** (steps 2 & 3):
  1. `updatePartnerLevelEventAudit(requestType, PARTNER, requestId, IN_PROGRESS, request, null)`
  2. Call `fsBnplPort.{method}(request)`
  3. On success: `updatePartnerLevelEventAudit(..., SUCCESS, request, response)`
  4. On failure: `updatePartnerLevelEventAudit(..., FAILED, request, error)` → re-throw

### Controller
- **4-step audit pattern** (matching `BorrowerDataIntegrationController` exactly):
  1. `startServiceEventAudit(requestId, PARTNER, requestType, requestPayload)` — idempotency check
  2. If `"SUCCESS".equals(auditEntity.getStatus())` → return cached response from `messageDetail`
  3. Call service → `successServiceEventAudit(auditId, metadata)` on success
  4. Catch → `failedServiceEventAudit(auditId, error)` → re-throw
- **MDC logging** — `MDC.put("request.id", requestId)` in try-finally
- **`@RequiredArgsConstructor`** — constructor injection (Brick pattern)
- **`@RequestAttribute("x-request-id")`** — request correlation ID

### Flyway Configuration
- **Add to `application.yml`**:
  ```yaml
  spring:
    flyway:
      enabled: true
      schemas: ${DB_SCHEMA:development}
      locations: classpath:db/migration
      out-of-order: true
  ```
- **Baseline migration** — `V1__Add_Flyway_Baseline.sql` (no-op, establishes version history)
- **Migration directory** — `src/main/resources/db/migration/`

### Partner Signature Configuration
- **Add path pattern** — `/fs/brick/service/application/v1/**` to the Veefin partner signature config in `application.yml`

### Steps
1. Create 6 model classes in `model/application/`
2. Add 3 methods to `FsBnplPort` interface
3. Add 3 method implementations to `FsBnplAdapter`
4. Create `ApplicationIntegrationService` interface
5. Create `ApplicationIntegrationServiceImpl` with partner-level audit
6. Create `ApplicationIntegrationController` with 4-step service-level audit
7. Add Flyway config to `application.yml`
8. Add partner signature path patterns
9. Create baseline Flyway migration
10. Write unit tests (controller + service + adapter) with 100% coverage

---

## 4. EventAuditUtil 4-Step Pattern (Critical)

### The Pattern
This is the **mandatory** pattern for all Brick service controller endpoints:

```java
// In Controller:
PartnerEventAuditEntity auditEntity = eventAuditUtil.startServiceEventAudit(
    requestId, PARTNER, REQUEST_TYPE, requestPayloadJson);

if ("SUCCESS".equals(auditEntity.getStatus())) {
    return buildResponseFromAudit(auditEntity); // Idempotency
}

try {
    Response response = service.process(request, requestId);
    eventAuditUtil.successServiceEventAudit(auditEntity.getId(), toJson(response));
    return ResponseEntity.ok(response);
} catch (Exception e) {
    eventAuditUtil.failedServiceEventAudit(auditEntity.getId(), "Error: " + e.getMessage());
    throw e;
}

// In Service (partner-level audit):
eventAuditUtil.updatePartnerLevelEventAudit(
    requestType, PARTNER, requestId, IN_PROGRESS, requestJson, null);
try {
    Response response = fsBnplPort.doSomething(request);
    eventAuditUtil.updatePartnerLevelEventAudit(
        requestType, PARTNER, requestId, SUCCESS, requestJson, responseJson);
    return response;
} catch (Exception e) {
    eventAuditUtil.updatePartnerLevelEventAudit(
        requestType, PARTNER, requestId, FAILED, requestJson, e.getMessage());
    throw e;
}
```

### Common Mistakes to Avoid
- Check `auditEntity.getStatus()` (not a non-existent `responseData` field)
- Always call all 4 steps in sequence
- Store response in `partnerMessageDetail` for idempotency
- Use `startServiceEventAudit`'s built-in idempotency (don't create custom logic)

---

## 5. Inter-Service Communication Pattern

### Brick → BNPL Calls
- `FsBnplPort` (interface) → `FsBnplAdapter` (implementation)
- Uses `RestTemplateService.executeServiceCall()` with `los-auth-token` authentication
- URL built with `UriComponentsBuilder.fromUriString(baseUrl).path("...").encode().toUriString()`
- BNPL endpoints return objects directly (no `ResponseDto` wrapper) for inter-service calls
- Null response → throw `RuntimeException`

---

## 6. Testing Strategy (Java)

### BNPL Service Tests
- **Controller tests** — `@WebMvcTest` with `excludeFilters` for `LosServiceFilter` and config/filter packages
- **Service tests** — `@ExtendWith(MockitoExtension.class)` with `@Mock` for repositories
- `@MockBean` for service dependencies in controller tests
- `@DisplayName` annotations for readable test names
- MockMvc for HTTP request/response verification

### Brick Service Tests
- **Controller tests** — `@ExtendWith(MockitoExtension.class)` with `MockMvcBuilders.standaloneSetup()`
- **Service tests** — `@ExtendWith(MockitoExtension.class)` with `@Mock` for dependencies
- **Adapter tests** — `@ExtendWith(MockitoExtension.class)` with `@Mock RestTemplateService`
- Test the 4-step audit pattern: new request, idempotent request, error path
- `.requestAttr("x-request-id", requestId)` for request correlation in tests

### Coverage Target
- 100% line/method coverage on all new code
- All branches covered (success, failure, idempotency, validation errors)
- Following SOLID, DRY, KISS principles

---

## 7. Key Patterns Reference

| Pattern | BNPL Service | Brick Service |
|---------|-------------|---------------|
| DI Style | `@Autowired` (field) | `@RequiredArgsConstructor` (constructor) |
| Response | `ResponseEntity<?>` (direct object) | `ResponseEntity<T>` (typed) |
| Auth | `los-auth-token` header | Veefin partner signature |
| Audit | None (internal endpoint) | 4-step EventAuditUtil pattern |
| Logging | `@Slf4j` + `log.info()` | `@Slf4j` + MDC + `log.debug()` |
| Validation | `@Valid @RequestBody` | `@Valid @RequestBody` + `@RequestAttribute` |
| Request ID | Not used | `@RequestAttribute("x-request-id")` |
| Test Pattern | `@WebMvcTest` + `@MockBean` | `@ExtendWith(MockitoExtension)` + standaloneSetup |
