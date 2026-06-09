import { describe, expect, it } from "vitest";
import {
  extractAgentQuestionItems,
  extractAgentQuestionsFromText,
} from "./agent-question-parser.js";

const SCREENSHOT_STYLE_TEXT = `
Four quick questions before I build the design direction - this shapes everything.

**1. Background feel**
The current site is very dark (near-black with glow). For the calm redesign:
- A) Dark stays, but calmer - pull back the glow and noise, think Linear or Resend
- B) Light / off-white - flip to a clean airy surface, think Loom or Notion
- C) Neutral mid-tone - warm gray or cool slate, grounded feel
- D) Open to your proposal - you decide and I'll react

**2. Audience**
Who primarily lands on this site?
- A) Executives / VP Sales - ROI and credibility above all
- B) Ops / RevOps practitioners - want to understand the product fast
- C) Mixed - top of page sells the exec, rest satisfies the practitioner

**3. Colors**
Current accents are violet \`#8b5cf6\` and cyan \`#22d3ee\`. For the calm direction:
- A) Keep violet as anchor - desaturate slightly, drop the cyan, one-accent system
- B) Full reset - you pick what serves calm best, I'm not attached to the current palette
- C) Neutral with one warm accent - move toward slate, stone, or muted amber

**4. Reference site** (any industry)
Is there a site that already feels like the vibe you want?
- A) Linear.app - dark, minimal, deliberate, negative space does the work
- B) Stripe / Clerk - clean professional, trust signals, light-leaning
- C) Loom / Notion - friendly but polished, soft background, approachable
- D) No reference - propose something and I'll react
`;

describe("agent question parser", () => {
  it("extracts screenshot-style bold numbered option blocks as structured questions", () => {
    const items = extractAgentQuestionItems(SCREENSHOT_STYLE_TEXT);

    expect(items).toHaveLength(4);
    expect(items[0]?.body).toContain("Background feel");
    expect(items[0]?.body).toContain("For the calm redesign");
    expect(items[0]?.choices).toHaveLength(4);
    expect(items[0]?.choices?.[0]).toContain("A) Dark stays");
    expect(items[1]?.choices).toHaveLength(3);
    expect(items[2]?.choices).toHaveLength(3);
    expect(items[3]?.choices).toHaveLength(4);
  });

  it("returns display-ready fallback strings for the same option format", () => {
    const out = extractAgentQuestionsFromText(SCREENSHOT_STYLE_TEXT);

    expect(out).toHaveLength(4);
    expect(out[0]).toContain("Background feel");
    expect(out[0]).toContain("- A) Dark stays");
    expect(out[3]).toContain("- D) No reference");
  });

  it("parses option blocks from JSON-stringified run result text", () => {
    const source = JSON.stringify({ result: SCREENSHOT_STYLE_TEXT });
    const out = extractAgentQuestionItems(source);

    expect(out).toHaveLength(4);
    expect(out[0]?.choices).toHaveLength(4);
  });

  it("does not convert an ordinary numbered implementation plan into questions", () => {
    const out = extractAgentQuestionItems(`
Implementation plan:

**1. Update theme tokens**
- Edit CSS variables
- Replace glow shadows

**2. Refactor components**
- Update buttons
- Rebuild cards

**3. Verify**
- Run tests
- Build the UI
`);

    expect(out).toEqual([]);
  });

  it("ignores trailing pleasantries", () => {
    const out = extractAgentQuestionsFromText(`
Build finished.

- Want me to do anything else?
- Should I continue with the second phase?
`);

    expect(out).toEqual([]);
  });

  it("keeps existing Open questions extraction behavior", () => {
    const out = extractAgentQuestionsFromText(`
## Open questions
1. Do we have sandbox access?
2. Which provider should we prefer?
`);

    expect(out).toEqual(["Do we have sandbox access?", "Which provider should we prefer?"]);
  });
});
