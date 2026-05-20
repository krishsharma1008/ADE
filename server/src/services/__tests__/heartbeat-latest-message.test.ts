import { describe, expect, it } from "vitest";
import { deriveLatestUserFacingAgentMessage } from "../heartbeat.js";

describe("deriveLatestUserFacingAgentMessage", () => {
  it("does not surface raw log or code tails as user-facing messages", () => {
    const raw = `
setDemographicPayload({
  spouseName: value,
  businessAddress: address,
});
stdout: wrote file
    `;

    expect(deriveLatestUserFacingAgentMessage(raw, null)).toBeNull();
  });

  it("does not surface raw demographic setter QA output as a latest message", () => {
    const raw = `
stdout: demographic setter output
class BankValidationRequestDto {
  private String accountNumber;
  @JsonProperty(value = "is_payment_in")
  private Boolean isPaymentIn;
  @JsonSetter(nulls = Nulls.SKIP)
  private Boolean isPaymentIn = false;
}
ERROR Unsupported class file major version 69 while compiling settings.gradle
    `;

    expect(deriveLatestUserFacingAgentMessage(raw, null)).toBeNull();
  });

  it("uses structured adapter summaries", () => {
    expect(
      deriveLatestUserFacingAgentMessage("raw logs", { summary: "QA needs a field mapping decision." }),
    ).toBe("QA needs a field mapping decision.");
  });

  it("uses extracted structured questions", () => {
    const text = `
## Open questions
- Which field mapping should I use for spouse income?
    `;

    expect(deriveLatestUserFacingAgentMessage(text, null)).toContain("Which field mapping");
  });
});
