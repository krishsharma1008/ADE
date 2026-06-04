import { REDACTED_EVENT_VALUE, SECRET_PAYLOAD_KEY_RE } from "./redaction.js";

/**
 * Body-text secret scanner (MEMORY_UI_AND_QUALITY_PLAN §1.4.1, CENTRAL_CONTEXT_DB_PLAN §4.4).
 *
 * `redaction.ts` is KEY-based: it tests object keys / JWT-shaped values inside a
 * structured record. It cannot scan a free-text body. The human-answer channel is a
 * credential-bearing channel by design (agents are instructed to escalate to the human
 * for credentials/access, per agent-question-routing.ts:194), so the captured answer
 * body — and any text the embedder would later egress — must be scanned for credential
 * shapes BEFORE it lands in the highest-trust, never-expiring `workspace` tier.
 *
 * This is best-effort regex: it bounds *credential* leakage only. It will miss novel
 * secret shapes and does NOT redact non-secret-but-sensitive business prose. Capture
 * hooks treat any finding as a hard `needs_review` quarantine signal, not a guarantee.
 */

export type SecretFindingType =
  | "api-key"
  | "jwt"
  | "connection-string"
  | "pem"
  | "labelled-secret";

export interface Finding {
  type: SecretFindingType;
  match: string;
}

export interface ScanResult {
  clean: string;
  findings: Finding[];
}

/**
 * Label regex REUSED from redaction.ts:1 (SECRET_PAYLOAD_KEY_RE) — the set of secret-ish
 * field labels. We pair it with a value matcher so prose like `api_key: sk-live-AABBCC…`
 * or `password = hunter2hunter2hunter2…` is caught even when the value alone is not a
 * known provider shape (high-entropy 20+ char token following a secret-ish label +
 * separator). Strip the capture group + flags from the shared source so it can be
 * embedded inside the larger label+value pattern below.
 */
const SECRET_LABEL_SOURCE = SECRET_PAYLOAD_KEY_RE.source.replace(/^\(/, "(?:");

// Provider/key shapes. Each is anchored on a word boundary and kept conservative so we
// do not over-redact ordinary prose.
const PATTERNS: { type: SecretFindingType; re: RegExp }[] = [
  // OpenAI-style sk- keys (incl. sk-proj-/sk-live-…). 20+ trailing key chars.
  { type: "api-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  // AWS access key id.
  { type: "api-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  // GitHub personal access / fine-grained tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_).
  { type: "api-key", re: /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  // Slack bot/user/app tokens.
  { type: "api-key", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // Postgres / generic SQL connection strings carrying inline credentials.
  { type: "connection-string", re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s'"]*@[^\s'"]+/gi },
  // PEM private-key blocks (multiline).
  {
    type: "pem",
    re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  },
];

// High-entropy token (20+ chars, base64/hex/url-safe-ish) following a secret-ish label
// and a separator that is either a literal `:`/`=` or a short connecting word
// (`is`/`was`/`:`) as used in prose like "the prod password is hunter2…". Captures the
// value group only so the label survives the redaction.
const LABELLED_SECRET_RE = new RegExp(
  `\\b${SECRET_LABEL_SOURCE}\\b\\s*(?:[:=]|\\b(?:is|was|=)\\b)\\s*['"\`]?([A-Za-z0-9_+\\/.=-]{20,})['"\`]?`,
  "gi",
);

// JWT detector for FREE TEXT. This is deliberately a purpose-built constant rather than a
// de-anchored reuse of redaction.ts's JWT_VALUE_RE. JWT_VALUE_RE's segments are
// `[A-Za-z0-9_-]+` (one char minimum), which is safe ONLY when ^…$-anchored against a whole
// structured value. De-anchored to `\b…\b` for prose scanning it would match any dotted
// triple — semvers (`1.2.3`), hostnames (`api.example.com`), filenames (`config.test.js`),
// and dotted identifiers (`module.exports.handler`) — wrongly quarantining ordinary
// engineering answers and irreversibly redacting their load-bearing spans.
//
// Real JWTs always begin with the base64url encoding of `{"` → `eyJ`, so we anchor on that
// header prefix and require non-trivial segment lengths. This catches genuine bearer tokens
// while rejecting semvers/domains/filenames/dotted identifiers.
const JWT_BODY_RE =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+)?\b/g;

export function scanBody(text: string): ScanResult {
  if (typeof text !== "string" || text.length === 0) {
    return { clean: typeof text === "string" ? text : "", findings: [] };
  }

  const findings: Finding[] = [];
  let clean = text;

  const redactWhole = (re: RegExp, type: SecretFindingType) => {
    clean = clean.replace(re, (match) => {
      findings.push({ type, match });
      return REDACTED_EVENT_VALUE;
    });
  };

  for (const { type, re } of PATTERNS) {
    redactWhole(new RegExp(re.source, re.flags), type);
  }

  // JWTs: reuse the redaction.ts shape. Skip three-segment dotted tokens already covered.
  redactWhole(new RegExp(JWT_BODY_RE.source, JWT_BODY_RE.flags), "jwt");

  // Labelled high-entropy values: redact only the value span, keep the label so the
  // captured prose still reads "the api_key is ***REDACTED***".
  clean = clean.replace(LABELLED_SECRET_RE, (match, value: string) => {
    findings.push({ type: "labelled-secret", match: value });
    return match.replace(value, REDACTED_EVENT_VALUE);
  });

  return { clean, findings };
}
