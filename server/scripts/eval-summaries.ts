// Round 3 Phase 6 PR 6.5 — CLI runner for the summarizer quality harness.
//
// Usage:
//   COMBYNE_SUMMARIZER_ANTHROPIC_API_KEY=sk-ant-... \
//     pnpm --filter @combyne/server exec tsx scripts/eval-summaries.ts
//
// Flags:
//   --fixtures <glob>      Default: tests/fixtures/summarizer/fix-*.json
//   --baseline <path>      Default: tests/fixtures/summarizer/baseline-anchors.json
//   --model <name>         Default: claude-haiku-4-5
//   --mode <summary|control|both>  Default: both
//   --fail-on-regression   Exit 1 if any baseline check fails. Default: off.
//   --print-contexts       Dump each composed context to stdout. Default: off.
//
// Leaves all DB writes out — this script reads fixtures and calls the
// summarizer driver directly, so it's safe to run against production
// credentials without touching shared state.

import { readdir } from "node:fs/promises";
import path from "node:path";
import { makeAnthropicSummarizerDriver } from "../src/services/summarizer-driver-anthropic.js";
import {
  aggregate,
  checkAgainstBaseline,
  loadBaselineFile,
  loadFixtureFile,
  makeKeyFactsJudge,
  runEval,
  type Answerer,
  type BaselineCheck,
  type RunEvalResult,
  type RunMode,
} from "../src/services/summarizer-eval.js";

interface Args {
  fixturesDir: string;
  baselinePath: string;
  model: string;
  modes: RunMode[];
  failOnRegression: boolean;
  printContexts: boolean;
}

function parseArgs(): Args {
  const args: Args = {
    fixturesDir: path.resolve(process.cwd(), "tests/fixtures/summarizer"),
    baselinePath: path.resolve(
      process.cwd(),
      "tests/fixtures/summarizer/baseline-anchors.json",
    ),
    model: "claude-haiku-4-5",
    modes: ["summary", "control"],
    failOnRegression: false,
    printContexts: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--fixtures") args.fixturesDir = argv[++i];
    else if (flag === "--baseline") args.baselinePath = argv[++i];
    else if (flag === "--model") args.model = argv[++i];
    else if (flag === "--mode") {
      const v = argv[++i];
      args.modes = v === "both" ? ["summary", "control"] : [v as RunMode];
    } else if (flag === "--fail-on-regression") args.failOnRegression = true;
    else if (flag === "--print-contexts") args.printContexts = true;
    else if (flag === "--help" || flag === "-h") {
      console.log(
        "Usage: eval-summaries [--fixtures DIR] [--baseline PATH] [--model NAME] [--mode summary|control|both] [--fail-on-regression] [--print-contexts]",
      );
      process.exit(0);
    }
  }
  return args;
}

async function listFixtureFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries
    .filter((n) => n.startsWith("fix-") && n.endsWith(".json"))
    .map((n) => path.join(dir, n))
    .sort();
}

// Anthropic-powered answerer: uses the same driver scaffolding as the
// summarizer so API key plumbing is shared.
function makeAnthropicAnswerer(): Answerer {
  const driver = makeAnthropicSummarizerDriver();
  return {
    async answer({ systemPrompt, userPrompt, model }) {
      // Piggyback on the summarizer driver: call with scope="standing" so
      // the response isn't forced into a JSON object.
      // The driver returns raw text; we return it verbatim.
      const out = await driver.invoke({
        systemPrompt,
        userPrompt,
        model,
        scope: "standing",
        maxOutputTokens: 600,
      });
      return {
        text: out.raw,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
      };
    },
  };
}

function fmt(x: number): string {
  return x.toFixed(3);
}

function printRun(r: RunEvalResult, args: Args): void {
  console.log(
    `  ${r.mode.padEnd(8)} accuracy=${fmt(r.accuracy)}  tail=${r.tailTokens}t  summary=${r.summaryTokens}t`,
  );
  for (const q of r.perQuestion) {
    const marker = q.judge.score >= 0.9 ? "✓" : q.judge.score >= 0.5 ? "≈" : "✗";
    console.log(
      `    ${marker} [${q.questionId}] ${fmt(q.judge.score)} — ${q.question}`,
    );
    if (q.judge.missingFacts.length > 0) {
      console.log(`       missing: ${q.judge.missingFacts.join(", ")}`);
    }
    if (q.judge.violatedAvoids.length > 0) {
      console.log(`       violated: ${q.judge.violatedAvoids.join(", ")}`);
    }
  }
  if (args.printContexts) {
    console.log("    --- context ---");
    console.log(r.tailContent.split("\n").map((l) => `      ${l}`).join("\n"));
    console.log("    --- /context ---");
  }
}

async function main(): Promise<number> {
  const args = parseArgs();
  console.log(
    `eval-summaries: fixtures=${args.fixturesDir} baseline=${args.baselinePath} model=${args.model} modes=${args.modes.join(",")}`,
  );
  const apiKey =
    process.env.COMBYNE_SUMMARIZER_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      "Missing API key: set COMBYNE_SUMMARIZER_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY.",
    );
    return 2;
  }
  const driver = makeAnthropicSummarizerDriver();
  const answerer = makeAnthropicAnswerer();
  const judge = makeKeyFactsJudge();
  const baseline = await loadBaselineFile(args.baselinePath).catch(() => ({
    tolerance: 0.1,
    anchors: [],
  }));

  const files = await listFixtureFiles(args.fixturesDir);
  if (files.length === 0) {
    console.error(`No fixtures found in ${args.fixturesDir}`);
    return 2;
  }

  const allResults: RunEvalResult[] = [];
  const allChecks: BaselineCheck[] = [];
  for (const file of files) {
    const loaded = await loadFixtureFile(file);
    for (const fx of loaded.fixtures) {
      console.log(`\n[${fx.id}] ${fx.description}`);
      for (const mode of args.modes) {
        const result = await runEval({
          fixture: fx,
          mode,
          summarizerDriver: driver,
          answerer,
          judge,
          model: args.model,
        });
        allResults.push(result);
        printRun(result, args);
        const check = checkAgainstBaseline(result, baseline);
        allChecks.push(check);
        if (!check.passed) {
          console.log(
            `    ⚠ baseline regression: anchor=${fmt(check.anchor)} observed=${fmt(check.observed)} delta=${fmt(check.delta)}`,
          );
        }
      }
    }
  }

  const report = aggregate(allResults, allChecks);
  console.log("\n=== summary ===");
  console.log(`fixtures:        ${report.totalFixtures}`);
  console.log(`questions:       ${report.totalQuestions}`);
  console.log(`summary mean:    ${fmt(report.summaryAccuracyMean)}`);
  console.log(`control mean:    ${fmt(report.controlAccuracyMean)}`);
  console.log(`lift (sum-ctl):  ${fmt(report.liftMean)}`);
  console.log(`regressions:     ${report.regressions.length}`);
  if (report.regressions.length > 0) {
    for (const r of report.regressions) {
      console.log(
        `  - ${r.fixtureId} (${r.mode}): anchor=${fmt(r.anchor)} observed=${fmt(r.observed)}`,
      );
    }
  }
  return args.failOnRegression && report.regressions.length > 0 ? 1 : 0;
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((err) => {
    console.error("eval-summaries failed:", err);
    process.exitCode = 1;
  });
