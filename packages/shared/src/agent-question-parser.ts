export interface ExtractedAgentQuestion {
  body: string;
  choices: string[] | null;
}

const DEFAULT_MAX_QUESTIONS = 10;
const MIN_QUESTION_LENGTH = 10;
const MAX_QUESTION_LENGTH = 1500;

const QUESTION_SECTION_HEADERS = [
  /^#{1,6}\s+open\s+questions?\b/i,
  /^#{1,6}\s+clarifying\s+questions?\b/i,
  /^#{1,6}\s+clarifications?\b/i,
  /^#{1,6}\s+clarification\s+(?:needed|required)\b/i,
  /^#{1,6}\s+questions?\s+for\s+(?:the\s+)?user\b/i,
  /^#{1,6}\s+questions?\s+pending\b/i,
  /^#{1,6}\s+decision\s+(?:needed|required)\b/i,
  /^#{1,6}\s+needs?\s+input\b/i,
  /^\*\*(?:open\s+questions?|clarifying\s+questions?|clarifications?|clarification\s+(?:needed|required)|decision\s+(?:needed|required)|needs?\s+input)\*\*/i,
];

const USER_INPUT_SECTION_HEADERS = [
  /^#{1,6}\s+blockers?\b/i,
  /^#{1,6}\s+blocked\b/i,
  /^#{1,6}\s+needs?\s+user\s+input\b/i,
  /^#{1,6}\s+needs?\s+input\b/i,
  /^#{1,6}\s+input\s+(?:needed|required)\b/i,
  /^#{1,6}\s+waiting\s+on\s+(?:the\s+)?user\b/i,
  /^#{1,6}\s+cannot\s+proceed\b/i,
  /^#{1,6}\s+action\s+required\b/i,
  /^#{1,6}\s+decision\s+(?:needed|required)\b/i,
  /^#{1,6}\s+clarifications?\b/i,
  /^#{1,6}\s+clarification\s+(?:needed|required)\b/i,
  /^#{1,6}\s+notes?\b/i,
  /^\*\*(?:blockers?|blocked|needs?\s+(?:user\s+)?input|input\s+(?:needed|required)|waiting\s+on\s+(?:the\s+)?user|cannot\s+proceed|action\s+required|decision\s+(?:needed|required)|clarifications?|clarification\s+(?:needed|required)|notes?)\*\*/i,
];

const USER_INPUT_INTENT_PATTERNS: RegExp[] = [
  /\b(?:need|needs|needed|requires?|required|choose|decide|decision|confirm|provide|input|clarify|clarification|which|whether)\b/i,
];

const OPTION_BLOCK_CUE_PATTERNS: RegExp[] = [
  /\b(?:quick\s+)?questions?\s+before\b/i,
  /\bbefore\s+(?:i|we)\b.{0,100}\b(?:build|implement|start|continue|proceed|make|change|design)\b/i,
  /\bthis\s+shapes\s+everything\b/i,
  /\b(?:pick|choose|select|decide)\s+(?:one|an?\s+option|a\s+direction)\b/i,
];

const OPTION_BLOCK_INTENT_PATTERNS: RegExp[] = [
  /\b(?:question|choose|decide|decision|confirm|provide|input|clarify|clarification|which|whether|preference|direction|option)\b/i,
];

const PLEASANTRY_PATTERNS: RegExp[] = [
  /^(?:do you (?:want|need)|would you like|want me to|shall i|should i (?:also )?(?:do|continue|proceed|keep|move|go))\b/i,
  /^(?:is there|anything (?:else|more)|need anything|let me know|sound good|sounds good|make sense|does that (?:work|make sense)|ok with you|good with you|happy with)\b/i,
  /^(?:can i (?:help|assist|do)|may i (?:help|assist)|how (?:does|do) that (?:look|sound))\b/i,
];

export function extractAgentQuestionItems(
  raw: string,
  maxQuestions: number = DEFAULT_MAX_QUESTIONS,
): ExtractedAgentQuestion[] {
  if (!raw || typeof raw !== "string") return [];
  const text = normalizeEmbeddedNewlines(raw);
  const lines = text.split(/\r?\n/);

  const blockerItems = extractUserInputSectionQuestions(lines);
  const sectionItems = extractDedicatedQuestionSectionItems(lines);
  const fallbackItems = sectionItems.length === 0 ? extractFallbackQuestionItems(lines) : [];
  const optionBlockItems = extractOptionBlockQuestionItems(lines, text);

  const candidates = [
    ...blockerItems,
    ...(sectionItems.length > 0 ? sectionItems : fallbackItems),
    ...optionBlockItems,
  ];

  const seen = new Set<string>();
  const out: ExtractedAgentQuestion[] = [];
  for (const candidate of candidates) {
    const compacted = compactQuestionItem(candidate);
    if (!compacted) continue;
    const displayText = formatExtractedAgentQuestion(compacted);
    if (displayText.length < MIN_QUESTION_LENGTH) continue;
    if (isPleasantryQuestion(compacted.body)) continue;
    const key = normalizeKey(displayText);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(compacted);
    if (out.length >= maxQuestions) break;
  }
  return out;
}

export function extractAgentQuestionsFromText(
  raw: string,
  maxQuestions: number = DEFAULT_MAX_QUESTIONS,
): string[] {
  return extractAgentQuestionItems(raw, maxQuestions).map(formatExtractedAgentQuestion);
}

export function formatExtractedAgentQuestion(item: ExtractedAgentQuestion): string {
  const choices = item.choices?.filter((choice) => choice.trim()) ?? [];
  return [item.body.trim(), ...choices.map((choice) => `- ${choice.trim()}`)].join("\n").trim();
}

function extractDedicatedQuestionSectionItems(lines: string[]): ExtractedAgentQuestion[] {
  let insideSection = false;
  const out: ExtractedAgentQuestion[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const isSectionHeader = QUESTION_SECTION_HEADERS.some((re) => re.test(line));
    if (isSectionHeader) {
      insideSection = true;
      continue;
    }
    if (insideSection && /^#{1,6}\s+/.test(line)) {
      insideSection = false;
      continue;
    }
    if (!insideSection) continue;
    // Under a DEDICATED question-section header, a line is a question if it CONTAINS
    // a '?', not only if it ENDS with one — agents routinely append a clarifying
    // clause after the question mark (e.g. "...still calling these endpoints? Phase 2
    // removal is blocked on this confirmation."). The header already signals intent,
    // so contains-'?' is safe here; the header-less fallback path stays strict.
    const item = stripBullet(line) || (line.includes("?") ? stripMarkdownEmphasis(line) : "");
    if (item && item.includes("?")) out.push({ body: item, choices: null });
  }
  return out;
}

function extractFallbackQuestionItems(lines: string[]): ExtractedAgentQuestion[] {
  const out: ExtractedAgentQuestion[] = [];
  for (const rawLine of lines) {
    const item = stripBullet(rawLine.trim());
    if (item && item.endsWith("?")) out.push({ body: item, choices: null });
  }
  return out;
}

function extractOptionBlockQuestionItems(lines: string[], raw: string): ExtractedAgentQuestion[] {
  const hasQuestionSetCue = OPTION_BLOCK_CUE_PATTERNS.some((pattern) => pattern.test(raw));
  const blocks: Array<{ heading: string; lines: string[] }> = [];
  let current: { heading: string; lines: string[] } | null = null;

  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (current) current.lines.push("");
      continue;
    }
    const heading = parseNumberedTopicHeading(line);
    if (heading) {
      flush();
      current = { heading, lines: [] };
      continue;
    }
    if (current) current.lines.push(rawLine);
  }
  flush();

  if (blocks.length === 0) return [];
  const built = blocks.map(buildOptionBlockItem).filter((item): item is ExtractedAgentQuestion => Boolean(item));
  const blocksWithChoices = built.filter((item) => item.choices && item.choices.length >= 2).length;
  if (!hasQuestionSetCue && blocksWithChoices < 2) return [];

  return built.filter((item) => {
    if (hasQuestionSetCue) return true;
    if (!item.choices || item.choices.length < 2) return false;
    return OPTION_BLOCK_INTENT_PATTERNS.some((pattern) => pattern.test(formatExtractedAgentQuestion(item)));
  });
}

function buildOptionBlockItem(block: { heading: string; lines: string[] }): ExtractedAgentQuestion | null {
  const bodyLines: string[] = [];
  const choices: string[] = [];
  let insideChoices = false;
  for (const rawLine of block.lines) {
    const line = stripMarkdownEmphasis(rawLine.trim());
    if (!line) continue;
    const option = parseChoiceLine(line);
    if (option) {
      choices.push(option);
      insideChoices = true;
      continue;
    }
    if (insideChoices && choices.length > 0) {
      choices[choices.length - 1] = `${choices[choices.length - 1]} ${line}`;
      continue;
    }
    bodyLines.push(line);
  }

  if (choices.length === 0 && !bodyLines.some((line) => line.endsWith("?"))) return null;
  const body = [block.heading, ...bodyLines].join("\n").trim();
  if (!body) return null;
  return { body, choices: choices.length > 0 ? dedupeChoices(choices) : null };
}

function extractUserInputSectionQuestions(lines: string[]): ExtractedAgentQuestion[] {
  let insideSection = false;
  let currentSection: string[] = [];
  let currentHeader = "";
  const out: ExtractedAgentQuestion[] = [];

  const flush = () => {
    if (currentSection.length === 0) return;
    const prompt = buildUserInputQuestion(currentSection, currentHeader);
    if (prompt) out.push({ body: prompt, choices: null });
    currentSection = [];
    currentHeader = "";
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const isUserInputHeader = USER_INPUT_SECTION_HEADERS.some((re) => re.test(line));
    if (isUserInputHeader) {
      flush();
      insideSection = true;
      currentHeader = line;
      continue;
    }
    if (insideSection && /^#{1,6}\s+/.test(line)) {
      flush();
      insideSection = false;
      continue;
    }
    if (!insideSection) continue;
    currentSection.push(rawLine);
  }
  flush();

  return out;
}

function buildUserInputQuestion(sectionLines: string[], header = ""): string {
  const trimmedLines = sectionLines.map((line) => line.trim()).filter(Boolean);
  if (trimmedLines.length === 0) return "";

  const questionLines: string[] = [];
  const optionLines: string[] = [];
  let sawQuestion = false;

  for (const line of trimmedLines) {
    const strippedBullet = stripBullet(line);
    const normalized = strippedBullet || stripMarkdownEmphasis(line);
    if (!normalized) continue;
    if (!sawQuestion && strippedBullet && questionLines.length > 0) {
      optionLines.push(`- ${normalized}`);
      continue;
    }
    if (!sawQuestion) {
      questionLines.push(normalized);
      if (normalized.includes("?")) sawQuestion = true;
      continue;
    }
    if (strippedBullet) {
      optionLines.push(`- ${normalized}`);
      continue;
    }
    if (normalized.endsWith("?")) {
      questionLines.push(normalized);
    }
  }

  const hasQuestionMark = questionLines.some((line) => line.includes("?"));
  const hasStrongHeaderIntent = /\b(?:decision|input|clarification|clarifying)\b/i.test(header);
  const hasInputIntent = trimmedLines.some((line) =>
    USER_INPUT_INTENT_PATTERNS.some((pattern) => pattern.test(line)),
  );
  if (!hasQuestionMark && !hasStrongHeaderIntent && !hasInputIntent) return "";

  const promptLines = hasQuestionMark
    ? [...questionLines, ...optionLines]
    : [`Please clarify: ${questionLines.join(" ")}`, ...optionLines];
  return promptLines.join("\n").trim();
}

function parseNumberedTopicHeading(line: string): string | null {
  const cleaned = stripMarkdownEmphasis(line);
  const match = cleaned.match(/^\(?\d{1,2}\)?[.)]\s+(.+)$/);
  const heading = match?.[1]?.trim();
  if (!heading) return null;
  if (heading.length > 180) return null;
  return heading;
}

function parseChoiceLine(line: string): string | null {
  const match = line.match(/^(?:[-*+]\s*)?([A-Z])[\).]\s+(.+)$/i);
  const label = match?.[1]?.toUpperCase();
  const text = match?.[2]?.trim();
  if (!label || !text) return null;
  return `${label}) ${text}`;
}

function stripBullet(line: string): string {
  const deBolded = line.replace(/^\*\*\s*/, "");
  const bulletMatch = deBolded.match(
    /^(?:[-*+]\s+|\(\d+\)\s*|\d+[.)]\s+|Q\d+[:.)]\s*)(.*)$/i,
  );
  if (bulletMatch) return stripMarkdownEmphasis(bulletMatch[1]!.trim());
  return "";
}

function stripMarkdownEmphasis(value: string): string {
  return value.replace(/\*\*/g, "").trim();
}

function compactQuestionItem(item: ExtractedAgentQuestion): ExtractedAgentQuestion | null {
  const body = item.body.trim();
  if (!body) return null;
  const choices = dedupeChoices(item.choices ?? []);
  const compacted = {
    body,
    choices: choices.length > 0 ? choices : null,
  };
  const displayText = formatExtractedAgentQuestion(compacted);
  if (displayText.length <= MAX_QUESTION_LENGTH) return compacted;
  return {
    body: `${body.slice(0, MAX_QUESTION_LENGTH - 1).trimEnd()}...`,
    choices: null,
  };
}

function dedupeChoices(choices: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const choice of choices) {
    const trimmed = choice.trim();
    if (!trimmed) continue;
    const key = normalizeKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function isPleasantryQuestion(candidate: string): boolean {
  const trimmed = stripMarkdownEmphasis(candidate.trim().replace(/^\*+\s*/, "").replace(/\s*\*+$/, ""));
  return PLEASANTRY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeEmbeddedNewlines(value: string): string {
  return value.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
}
