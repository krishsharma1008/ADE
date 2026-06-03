# Clean Code & OOP Self-Review

Coaching reference for the **design self-review** (BUKU Pre-Push Step 7b). This is a
mandatory *pass*, not a redundant gate — SonarQube still enforces metrics post-PR.
The point is to catch the Clean-Code / OOP smells that draw 5–6 review comments per PR
*before* you push, so reviewers spend their time on design, not on telling you to extract
a method.

How to use this file:

1. After your functional change compiles and tests pass, re-read your diff against
   sections **A–G** below.
2. For each section, run the **checkable heuristic**. Where a threshold is given
   (method length, nesting depth, duplication count), it is **objective** — apply it.
3. If a smell is present, **refactor now**. Do not push-and-ask the reviewer to flag it.
4. Conform to the local repo's conventions first (see workflow Step 4.5). When a clean-code
   rule conflicts with a framework idiom the service already uses (e.g. BNPL's `@Autowired`
   field injection in `references/implementation-best-practices.md`), **follow the local
   convention**, note the trade-off in the PR description, and ask the reviewer/architect
   if you think the convention itself should change.

> These examples use real BukuWarung patterns (Spring Boot, layered/hexagonal, Lombok,
> Resilience4j, the `EventAuditUtil` 4-step audit, Feign clients). They mirror the
> conventions in `references/code-conventions.md`, `references/patterns.md`, and
> `references/implementation-best-practices.md`.

---

## A. Single Responsibility — one reason to change

**Rule:** A class (and a method) should have exactly one reason to change. If a service
both *orchestrates business logic* and *formats responses*, *talks to Kafka*, and
*builds audit JSON*, every one of those concerns is a separate reason to edit it.

**Smell:** A `…Service` / `…ServiceImpl` that injects six-plus collaborators of unrelated
kinds (repository **and** Feign client **and** `StreamBridge` **and** `ObjectMapper` **and**
a notification client), with private helpers that have nothing to do with each other. The
class name no longer describes what it does ("…and").

### BEFORE — `DisbursementServiceImpl` does four jobs

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class DisbursementServiceImpl implements DisbursementService {

    private final LoanRepository loanRepository;
    private final PaymentProviderClient paymentProviderClient; // external call
    private final StreamBridge streamBridge;                    // Kafka
    private final ObjectMapper objectMapper;                    // serialization
    private final NotificationClient notificationClient;        // SMS

    @Override
    @Transactional
    public DisbursementResponse disburse(DisbursementRequest request) {
        Loan loan = loanRepository.findById(request.getLoanId())
            .orElseThrow(() -> new ResourceNotFoundException("Loan", request.getLoanId()));

        PaymentResponse providerResult = paymentProviderClient.process(request.toProviderRequest());
        loan.setStatus(LoanStatus.DISBURSED);
        loanRepository.save(loan);

        // Builds + serializes the Kafka event inline
        DisbursementEvent event = DisbursementEvent.builder()
            .eventId(UUID.randomUUID().toString())
            .eventType("lending.disbursement.completed")
            .timestamp(Instant.now())
            .loanId(loan.getId())
            .amount(loan.getAmount())
            .build();
        try {
            String payload = objectMapper.writeValueAsString(event);
            streamBridge.send("lending-events", payload);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to serialize disbursement event", e);
        }

        // Sends the SMS inline
        notificationClient.sendSms(SmsRequest.builder()
            .userId(loan.getUserId())
            .template("DISBURSEMENT_DONE")
            .build());

        return DisbursementResponse.from(loan, providerResult);
    }
}
```

### AFTER — orchestration only; events and notifications move to their own collaborators

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class DisbursementServiceImpl implements DisbursementService {

    private final LoanRepository loanRepository;
    private final PaymentProviderClient paymentProviderClient;
    private final DisbursementEventPublisher eventPublisher;   // owns Kafka + serialization
    private final DisbursementNotifier notifier;               // owns SMS

    @Override
    @Transactional
    public DisbursementResponse disburse(DisbursementRequest request) {
        Loan loan = loadLoan(request.getLoanId());
        PaymentResponse providerResult = paymentProviderClient.process(request.toProviderRequest());

        loan.setStatus(LoanStatus.DISBURSED);
        loanRepository.save(loan);

        eventPublisher.publishDisbursed(loan);
        notifier.notifyDisbursed(loan);
        return DisbursementResponse.from(loan, providerResult);
    }

    private Loan loadLoan(String loanId) {
        return loanRepository.findById(loanId)
            .orElseThrow(() -> new ResourceNotFoundException("Loan", loanId));
    }
}
```

`DisbursementEventPublisher` now owns the `StreamBridge` + `ObjectMapper`; the notifier owns
the Feign call. Each has one reason to change (event schema; notification template).

**Checkable heuristic:** Can you describe the class in one sentence with **no "and"**? Does
it inject collaborators of **more than ~3 distinct kinds** (repo / external client / messaging
/ serialization / notification)? If yes, split out the secondary concern.

---

## B. Method complexity — objective ceilings

**Rule:** A method is too complex when it exceeds an objective ceiling. **Extract a method
when a method body is `> 25 lines` OR nesting depth is `> 3 levels`** (an `if` inside a `for`
inside a `try` is already 3). Also extract once cyclomatic complexity (independent branches)
passes ~10.

**Smell:** A controller/service method you have to scroll, with arrow-shaped indentation
(`if { for { if { … } } }`) and several `// ---- step N ----` comment banners. Those banners
are the method *asking* to be split.

### BEFORE — one method, 6 nesting levels deep (`for`→`if`→`if`→`try`→`if`→`if`)

```java
public ReconciliationResult reconcile(List<Transaction> txns, ReconcileConfig cfg) {
    ReconciliationResult result = new ReconciliationResult();
    for (Transaction txn : txns) {                                   // 1
        if (txn.getStatus() == TransactionStatus.SETTLED) {         // 2
            if (cfg.isProviderEnabled(txn.getProvider())) {         // 3
                try {                                               // 4
                    ProviderRecord rec = providerClient.fetch(txn.getReference());
                    if (rec != null) {                              // 5
                        if (rec.getAmount().compareTo(txn.getAmount()) == 0) {
                            result.addMatched(txn);
                        } else {
                            result.addMismatch(txn, rec);
                        }
                    } else {
                        result.addMissing(txn);
                    }
                } catch (ProviderException e) {
                    log.warn("Provider fetch failed for {}", txn.getReference(), e);
                    result.addError(txn);
                }
            }
        }
    }
    return result;
}
```

### AFTER — loop body extracted; comparison extracted; nesting ≤ 2

```java
public ReconciliationResult reconcile(List<Transaction> txns, ReconcileConfig cfg) {
    ReconciliationResult result = new ReconciliationResult();
    for (Transaction txn : txns) {
        reconcileOne(txn, cfg, result);
    }
    return result;
}

private void reconcileOne(Transaction txn, ReconcileConfig cfg, ReconciliationResult result) {
    if (txn.getStatus() != TransactionStatus.SETTLED) return;        // guard (see §E)
    if (!cfg.isProviderEnabled(txn.getProvider())) return;           // guard

    try {
        ProviderRecord rec = providerClient.fetch(txn.getReference());
        classify(txn, rec, result);
    } catch (ProviderException e) {
        log.warn("Provider fetch failed for {}", txn.getReference(), e);
        result.addError(txn);
    }
}

private void classify(Transaction txn, ProviderRecord rec, ReconciliationResult result) {
    if (rec == null) {
        result.addMissing(txn);
    } else if (rec.getAmount().compareTo(txn.getAmount()) == 0) {
        result.addMatched(txn);
    } else {
        result.addMismatch(txn, rec);
    }
}
```

**Checkable heuristic:** Count lines of the method body and the deepest nesting level.
`> 25 lines` **or** `> 3 levels` → extract. If you wrote a `// step N` banner comment, that
block is the method to extract.

---

## C. Extract Method + intention-revealing names

**Rule:** Replace an inline block (and its explanatory comment) with a call to a method whose
**name says what, not how**. The method name should let a reader skip the body. Names are
verb-first for behaviour (`buildAuditPayload`), boolean-reading for predicates (`isEligible`).

**Smell:** A comment that narrates the next few lines (`// check eligibility`), a boolean
expression assembled from 3+ clauses, or a magic-number / multi-clause condition inline in an
`if`.

### BEFORE — inline eligibility logic with a narrating comment

```java
public LoanDecision evaluate(BorrowerProfile profile) {
    // borrower is eligible if active, KYC verified, score high enough, not over the cap
    if (profile.getStatus() == BorrowerStatus.ACTIVE
            && profile.getKycStatus() == KycStatus.VERIFIED
            && profile.getCreditScore() >= 650
            && profile.getActiveLoanCount() < 3) {
        return LoanDecision.approved(profile);
    }
    return LoanDecision.rejected(profile);
}
```

### AFTER — the predicate has a name; the magic numbers become named constants

```java
private static final int MIN_CREDIT_SCORE = 650;
private static final int MAX_ACTIVE_LOANS = 3;

public LoanDecision evaluate(BorrowerProfile profile) {
    return isEligible(profile)
        ? LoanDecision.approved(profile)
        : LoanDecision.rejected(profile);
}

private boolean isEligible(BorrowerProfile profile) {
    return profile.getStatus() == BorrowerStatus.ACTIVE
        && profile.getKycStatus() == KycStatus.VERIFIED
        && profile.getCreditScore() >= MIN_CREDIT_SCORE
        && profile.getActiveLoanCount() < MAX_ACTIVE_LOANS;
}
```

**Checkable heuristic:** Every `//` comment that explains *what the next lines do* is a method
name waiting to happen. Any boolean condition with **≥ 3 clauses** or a **magic number** →
extract to a named predicate / named constant.

---

## D. DRY — extract on the third duplication

**Rule:** Don't Repeat Yourself. **Once the same shape of code appears `≥ 3` times, extract it.**
(Two near-duplicates can be a coincidence; three is a pattern.) Common BUKU targets: repeated
`UriComponentsBuilder` URL assembly in a Feign/`RestTemplateService` adapter, repeated
audit-status calls, repeated DTO→entity mapping.

**Smell:** Copy-pasted blocks that differ only by a path segment, a request type, or a field
name — and a bug fixed in one copy but not the others.

### BEFORE — three adapter methods repeat the same URL + call + null-check

```java
@Override
public DocumentUploadResponse uploadApplicationDocument(DocumentUploadRequest request) {
    String url = UriComponentsBuilder.fromUriString(baseUrl)
        .path("/application/document").encode().toUriString();
    DocumentUploadResponse resp = restTemplateService.executeServiceCall(
        url, HttpMethod.POST, "los-auth-token", fsBnplToken, request,
        "uploadApplicationDocument", DocumentUploadResponse.class, null);
    if (resp == null) throw new RuntimeException("Null response from BNPL: uploadApplicationDocument");
    return resp;
}

@Override
public UpdateApplicationResponse updateApplication(UpdateApplicationRequest request) {
    String url = UriComponentsBuilder.fromUriString(baseUrl)
        .path("/application/update").encode().toUriString();
    UpdateApplicationResponse resp = restTemplateService.executeServiceCall(
        url, HttpMethod.POST, "los-auth-token", fsBnplToken, request,
        "updateApplication", UpdateApplicationResponse.class, null);
    if (resp == null) throw new RuntimeException("Null response from BNPL: updateApplication");
    return resp;
}

// submitApplication(...) repeats the exact same shape a third time
```

### AFTER — one generic call helper; each method is a one-liner

```java
@Override
public DocumentUploadResponse uploadApplicationDocument(DocumentUploadRequest request) {
    return callBnpl("/application/document", request,
        "uploadApplicationDocument", DocumentUploadResponse.class);
}

@Override
public UpdateApplicationResponse updateApplication(UpdateApplicationRequest request) {
    return callBnpl("/application/update", request,
        "updateApplication", UpdateApplicationResponse.class);
}

private <T> T callBnpl(String path, Object request, String requestName, Class<T> responseType) {
    String url = UriComponentsBuilder.fromUriString(baseUrl).path(path).encode().toUriString();
    T response = restTemplateService.executeServiceCall(
        url, HttpMethod.POST, "los-auth-token", fsBnplToken, request, requestName, responseType, null);
    if (response == null) {
        throw new RuntimeException("Null response from BNPL: " + requestName);
    }
    return response;
}
```

**Checkable heuristic:** Search your diff for the same 3–5 line shape. **3+ occurrences →
extract** a shared private method (or mapper). One occurrence is fine; two, watch it; three,
fix it.

---

## E. Guard clauses over nested conditionals

**Rule:** Handle the negative / exceptional cases first with early `return`/`throw`, keeping
the **happy path un-indented** at the bottom. Prefer guard clauses to an `if/else` pyramid.

**Smell:** A method whose entire body is wrapped in `if (valid) { … } else { return error; }`,
or a deeply indented success path you have to read inside three braces.

### BEFORE — happy path buried inside nested `if`s

```java
public ResponseEntity<PaymentResponse> getPayment(String paymentId, String actorUserId) {
    if (actorUserId != null) {
        Optional<Payment> maybe = paymentRepository.findById(paymentId);
        if (maybe.isPresent()) {
            Payment payment = maybe.get();
            if (payment.getUserId().equals(actorUserId)) {
                return ResponseEntity.ok(PaymentResponse.from(payment));
            } else {
                throw new BusinessException("FORBIDDEN_403", "Not your payment");
            }
        } else {
            throw new ResourceNotFoundException("Payment", paymentId);
        }
    } else {
        throw new BusinessException("AUTH_401", "Missing actor");
    }
}
```

### AFTER — guards first; happy path flat at the end

```java
public ResponseEntity<PaymentResponse> getPayment(String paymentId, String actorUserId) {
    if (actorUserId == null) {
        throw new BusinessException("AUTH_401", "Missing actor");
    }
    Payment payment = paymentRepository.findById(paymentId)
        .orElseThrow(() -> new ResourceNotFoundException("Payment", paymentId));
    if (!payment.getUserId().equals(actorUserId)) {
        throw new BusinessException("FORBIDDEN_403", "Not your payment");
    }
    return ResponseEntity.ok(PaymentResponse.from(payment));
}
```

**Checkable heuristic:** Is the success path indented more than one level, or wrapped in an
`else`? Invert the condition, `return`/`throw` early, and delete the `else`. Replace
`Optional.isPresent()` + `get()` with `orElseThrow`.

---

## F. Composition over inheritance

**Rule:** Prefer assembling behaviour from injected collaborators (strategies, ports) over
extending a base class to reuse code. Inheritance couples you to the parent's lifecycle and to
fields you didn't choose; in Spring, an abstract base shared "to reuse a method" usually wants
to be a separate bean.

**Smell:** An abstract `Base…Service` that subclasses extend only to inherit a helper or a
template method; a `protected` field reached up into; a `switch`/`instanceof` ladder that a
strategy interface would replace.

### BEFORE — inheritance to share a helper; behaviour selected by type

```java
public abstract class BaseDisbursementService {
    protected final PaymentProviderClient providerClient; // shared via inheritance
    protected BaseDisbursementService(PaymentProviderClient c) { this.providerClient = c; }

    protected PaymentResponse callProvider(DisbursementRequest r) {
        return providerClient.process(r.toProviderRequest());
    }
    public abstract DisbursementResponse disburse(DisbursementRequest r);
}

public class BankDisbursementService extends BaseDisbursementService {
    public BankDisbursementService(PaymentProviderClient c) { super(c); }
    public DisbursementResponse disburse(DisbursementRequest r) { /* uses callProvider */ }
}

public class WalletDisbursementService extends BaseDisbursementService { /* … */ }
```

### AFTER — a strategy interface, composed and selected by a registry

```java
public interface DisbursementChannel {
    DisbursementMethod method();
    DisbursementResponse disburse(DisbursementRequest request);
}

@Component
@RequiredArgsConstructor
public class BankDisbursementChannel implements DisbursementChannel {
    private final PaymentProviderClient providerClient; // composed, not inherited
    public DisbursementMethod method() { return DisbursementMethod.BANK; }
    public DisbursementResponse disburse(DisbursementRequest request) { /* … */ }
}

@Service
public class DisbursementRouter {
    private final Map<DisbursementMethod, DisbursementChannel> channels;

    public DisbursementRouter(List<DisbursementChannel> channelBeans) {
        this.channels = channelBeans.stream()
            .collect(Collectors.toMap(DisbursementChannel::method, Function.identity()));
    }

    public DisbursementResponse disburse(DisbursementRequest request) {
        DisbursementChannel channel = channels.get(request.getMethod());
        if (channel == null) {
            throw new BusinessException("VALIDATION_ERROR", "Unsupported method: " + request.getMethod());
        }
        return channel.disburse(request);
    }
}
```

Adding a new channel is a new `@Component`, not an edit to a base class or a `switch`.

**Checkable heuristic:** Are you extending a class **only to reuse a method** (not to model a
true *is-a*)? Do subclasses share no real substitutable contract? Replace the base class with
an injected collaborator or a strategy interface selected from a `Map`.

---

## G. Intention-revealing tests

**Rule:** A test name states the behaviour and the condition; the body follows **Arrange /
Act / Assert** (Given/When/Then) with one logical assertion focus. The test should read as a
specification, not as a re-run of the implementation.

**Smell:** `test1()` / `testProcess()`; multiple unrelated scenarios crammed into one method;
asserting on mock internals instead of observable behaviour; no clear AAA separation.

### BEFORE — opaque name, two scenarios, no AAA

```java
@Test
void test() {
    PaymentRequest r = new PaymentRequest();
    r.setAmount(new BigDecimal("100000"));
    PaymentResponse ok = service.process(r);
    assertEquals(PaymentStatus.SUCCESS, ok.getStatus());
    r.setAmount(new BigDecimal("-1"));
    try { service.process(r); fail(); } catch (Exception e) {}
}
```

### AFTER — one behaviour per test, named, AAA-structured

```java
@Test
void shouldMarkPaymentSuccessfulWhenProviderAccepts() {
    // Arrange
    PaymentRequest request = PaymentRequest.builder()
        .userId("user-123").amount(new BigDecimal("100000")).build();
    when(providerClient.process(any())).thenReturn(acceptedResponse());

    // Act
    PaymentResponse response = service.process(request);

    // Assert
    assertThat(response.getStatus()).isEqualTo(PaymentStatus.SUCCESS);
    verify(notificationClient).sendPush(any());
}

@Test
void shouldThrowValidationExceptionWhenAmountIsNegative() {
    // Arrange
    PaymentRequest request = PaymentRequest.builder()
        .userId("user-123").amount(new BigDecimal("-1")).build();

    // Act & Assert
    assertThatThrownBy(() -> service.process(request))
        .isInstanceOf(ValidationException.class)
        .hasMessageContaining("Amount must be positive");
}
```

**Checkable heuristic:** Can a reader tell the scenario from the test name alone? Does each
test assert **one behaviour** with visible Arrange/Act/Assert? A `try/catch … fail()` for an
expected exception → replace with `assertThatThrownBy`. Two scenarios in one test → split.

---

## Quick self-review checklist

Run this against your diff (each item maps to a section above):

- [ ] **(A)** Every changed class is describable in one sentence with no "and".
- [ ] **(B)** No method body `> 25 lines` or `> 3` nesting levels.
- [ ] **(C)** No comment narrates code that should be a named method; no naked magic numbers.
- [ ] **(D)** No 3+ duplicated blocks; shared shape extracted.
- [ ] **(E)** Negative cases are guard clauses; the happy path is flat.
- [ ] **(F)** No inheritance used purely to share a helper; strategies are composed.
- [ ] **(G)** Every new test has an intention-revealing name and AAA structure.

If any box is unchecked, refactor **before** pushing. If a fix would violate a local framework
convention, keep the convention, document the trade-off, and ask the reviewer/architect.
