// Oracle probes for the seeded Lending corpus (2026-06-11). Each probe phrases a
// realistic dev ticket (deliberately NOT the entry's own wording) and asserts the
// expected entry ranks in the top-3 through the PRODUCTION recall route
// (POST /memory/query → queryRanked — the same function passdown uses).
const BASE = "http://127.0.0.1:3100/api";
const COMPANY = "b405dc3d-3dbe-4d37-b1ad-3a3a8895192c";
const BRICK = "krish-buku/fs-brick-service-test";
const BNPL = "krish-buku/fs-bnpl-service-test";

const ID = {
  "brick-jdk17": "6debc9d3-53af-4780-b38b-e99b49a0cd13",
  "brick-staging-base": "e4dc59d1-28bb-4d5d-8ae6-ca728492b879",
  "brick-global-handlers": "eaab1d90-ca2e-4718-88fc-f1193368d266",
  "brick-error-envelope": "59ea2a2a-c603-4427-a087-d07e30664a07",
  "brick-url-encode": "96912b77-0808-48af-b305-7debb35ca8cf",
  "brick-veefin-provider": "b11c4754-980e-4eda-95df-402d64f905d3",
  "brick-pefindo-adapter": "a7c51493-6878-4af8-b8c4-4c50cb879432",
  "brick-mockmvc": "a3bb4ea0-fce1-4893-8508-8594706030c7",
  "bnpl-jdk17": "11993416-0bb2-4169-83e0-3108bf3d046f",
  "bnpl-staging-base": "53abfc1c-fe51-4e4e-8abe-d6760dd4bee3",
  "bnpl-2fa-controller": "95b186dc-a137-4c9e-af35-c4a00351bfe5",
  "bnpl-pin-reset": "8b9f2145-6b79-4bb4-96a2-347980399f5a",
  "bnpl-2fa-audit": "0db7230f-9778-44b2-ab06-fc9a1d9e6edc",
  "bnpl-repayment-intent-deprecated": "4eca0470-1ac5-4d2b-8c89-5865a386d721",
  "team-merge-gate": "d4adea1b-0032-4537-a162-c7deae0bfc7a",
  // pre-existing round-2 target: the FE repayment-intent human answer
  "human-answer-repayment": "6f06a21d-1d9a-42da-b3f6-4d18dbcb82ec",
};

const probes = [
  { q: "gradle test fails to start locally, what java version does the build need", scope: BRICK, expect: "brick-jdk17" },
  { q: "which branch do I cut my feature branch from and target the pull request at", scope: BRICK, expect: "brick-staging-base" },
  { q: "[BE] [Brick] move BmuLoan exception handling out of the global advice into the controller", scope: BRICK, expect: "brick-global-handlers" },
  { q: "what error response body format should a new BmuLoan endpoint return on failure", scope: BRICK, expect: "brick-error-envelope" },
  { q: "construct the request URL with the customer id as a path segment in the client", scope: BRICK, expect: "brick-url-encode" },
  { q: "add a method to VeefinLosProvider calling the LOS application status API with a typed response", scope: BRICK, expect: "brick-veefin-provider" },
  { q: "extend PefindoAdapter with a new credit score lookup endpoint", scope: BRICK, expect: "brick-pefindo-adapter" },
  { q: "controller unit test throws NestedServletException instead of returning an error response", scope: BRICK, expect: "brick-mockmvc" },
  { q: "./gradlew test errors with unsupported java runtime version on my machine", scope: BNPL, expect: "bnpl-jdk17" },
  { q: "what is the merge base branch for bnpl pull requests", scope: BNPL, expect: "bnpl-staging-base" },
  { q: "add an OTP resend endpoint to the two factor authentication flow", scope: BNPL, expect: "bnpl-2fa-controller" },
  { q: "implement a forgot PIN flow with an initiate and confirm step", scope: BNPL, expect: "bnpl-pin-reset" },
  { q: "track failed PIN attempts and expose the lock status to the mobile app", scope: BNPL, expect: "bnpl-2fa-audit" },
  { q: "create a repayment intent when the user tops up credit", scope: BNPL, expect: "bnpl-repayment-intent-deprecated" },
  // company-wide entries must serve under a repo scope (the round-2 scope-or-NULL fix)
  { q: "can the agent merge the pull request itself once checks pass", scope: BRICK, expect: "team-merge-gate" },
  { q: "is the frontend still calling the repayment intent endpoints", scope: BNPL, expect: "human-answer-repayment" },
];

let top1 = 0, top3 = 0;
const failures = [];
for (const p of probes) {
  const res = await fetch(`${BASE}/companies/${COMPANY}/memory/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: p.q,
      layers: ["workspace", "shared"],
      serviceScope: p.scope,
      limit: 3,
    }),
  });
  const json = await res.json();
  const items = json.items ?? [];
  const ids = items.map((i) => i.id);
  const want = ID[p.expect];
  const rank = ids.indexOf(want);
  if (rank === 0) top1++;
  if (rank >= 0) top3++;
  else failures.push({ probe: p.q, expect: p.expect, got: items.map((i) => `${i.subject?.slice(0, 60)} (${i.score?.toFixed?.(3) ?? "?"})`) });
  console.log(`${rank >= 0 ? (rank === 0 ? "TOP1" : "TOP3") : "MISS"}  [${p.expect}] "${p.q.slice(0, 60)}"`);
}
console.log(`\ntop-1: ${top1}/${probes.length}  top-3: ${top3}/${probes.length}`);
if (failures.length) console.log("\nMISSES:\n" + JSON.stringify(failures, null, 1));
