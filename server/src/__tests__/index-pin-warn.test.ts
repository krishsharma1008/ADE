// B-PIN-5: checkPinnedCompanyAdoption — the pure decision behind the boot-time warn
// "COMBYNE_CONTEXT_COMPANY_ID is set but no local company has that id". Unit-tested
// without standing up the server (boot does the narrow companies query + passes ids).

import { describe, expect, it } from "vitest";
import { checkPinnedCompanyAdoption } from "../config.js";

const PIN = "abcdabcd-abcd-4abc-8abc-abcdabcdabcd";

describe("checkPinnedCompanyAdoption (B-PIN-5)", () => {
  it("warns (no throw) when the pin is set but no local company carries it, soft mode", () => {
    const r = checkPinnedCompanyAdoption({
      contextCompanyId: PIN,
      localCompanyIds: ["00000000-0000-4000-8000-000000000000"],
      contextRequired: false,
    });
    expect(r.warn).toContain(PIN);
    expect(r.warn).toMatch(/db:company-pin/);
    expect(r.throwMsg).toBeUndefined();
  });

  it("escalates to a throwMsg in strict mode (contextRequired)", () => {
    const r = checkPinnedCompanyAdoption({
      contextCompanyId: PIN,
      localCompanyIds: [],
      contextRequired: true,
    });
    expect(r.warn).toContain(PIN);
    expect(r.throwMsg).toMatch(/does not match any local company/i);
  });

  it("is silent when the pin IS present among local company ids", () => {
    const r = checkPinnedCompanyAdoption({
      contextCompanyId: PIN,
      localCompanyIds: ["x", PIN, "y"],
      contextRequired: true,
    });
    expect(r.warn).toBeUndefined();
    expect(r.throwMsg).toBeUndefined();
  });

  it("is a no-op when no pin is set", () => {
    const r = checkPinnedCompanyAdoption({
      contextCompanyId: "",
      localCompanyIds: [],
      contextRequired: true,
    });
    expect(r).toEqual({});
  });
});
