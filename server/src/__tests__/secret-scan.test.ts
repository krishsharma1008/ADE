import { describe, expect, it } from "vitest";
import { scanBody } from "../secret-scan.js";

describe("scanBody", () => {
  it("returns clean text and no findings for benign prose", () => {
    const text = "Use UTC for all scheduled jobs and document the default in the README.";
    const result = scanBody(text);
    expect(result.findings).toHaveLength(0);
    expect(result.clean).toBe(text);
  });

  it("redacts an OpenAI sk- key and reports an api-key finding", () => {
    const result = scanBody("Use sk-live-ABCDEFGHIJKLMNOPQRSTUVWX in prod");
    expect(result.findings.map((f) => f.type)).toContain("api-key");
    expect(result.clean).not.toContain("sk-live-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(result.clean).toContain("***REDACTED***");
  });

  it("redacts AWS, GitHub, and Slack key shapes", () => {
    expect(scanBody("AKIAIOSFODNN7EXAMPLE").findings[0]?.type).toBe("api-key");
    expect(scanBody("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789").findings[0]?.type).toBe("api-key");
    expect(scanBody("xoxb-12345-678901234-abcdEFGHijklMNOP").findings[0]?.type).toBe("api-key");
  });

  it("redacts postgres connection strings carrying inline credentials", () => {
    const result = scanBody("db is postgres://user:s3cretpass@db.internal:5432/app");
    expect(result.findings[0]?.type).toBe("connection-string");
    expect(result.clean).not.toContain("s3cretpass");
  });

  it("redacts a PEM private-key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBA\n-----END RSA PRIVATE KEY-----";
    const result = scanBody(`here it is: ${pem}`);
    expect(result.findings[0]?.type).toBe("pem");
    expect(result.clean).not.toContain("MIIBOgIBAAJBA");
  });

  it("redacts a real JWT (eyJ header) in free text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const result = scanBody(`session jwt ${jwt} here`);
    expect(result.findings[0]?.type).toBe("jwt");
    expect(result.clean).not.toContain(jwt);
  });

  it("does not flag semvers, hostnames, filenames, or dotted identifiers as JWTs", () => {
    const result = scanBody(
      "Deploy version 1.2.3 to api.example.com (see config.test.js) via module.exports.handler",
    );
    expect(result.findings).toHaveLength(0);
    expect(result.clean).not.toContain("***REDACTED***");
  });

  it("redacts a high-entropy value following a secret-ish label in prose", () => {
    const result = scanBody("the prod password is correcthorsebatterystaple9 ok");
    expect(result.findings[0]?.type).toBe("labelled-secret");
    expect(result.clean).toContain("the prod password is ***REDACTED*** ok");
  });

  it("does not over-redact ordinary 'X is Y' prose with short or non-secret values", () => {
    const result = scanBody("The deployment region is us-east-1 and it works fine.");
    expect(result.findings).toHaveLength(0);
  });

  it("handles empty / non-string input without throwing", () => {
    expect(scanBody("").findings).toHaveLength(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(scanBody(undefined as any).clean).toBe("");
  });
});
