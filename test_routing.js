/**
 * Local test harness — proves the routing logic before it is demoed.
 * Run: npm test
 */

import { decide, ROUTING_TABLE, DEFAULT_ROUTE } from "./routing.js";

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}` +
      (ok ? "" : `\n          expected ${JSON.stringify(expected)}\n          got      ${JSON.stringify(actual)}`)
  );
  ok ? passed++ : failed++;
}

// Grail-style payload (dotted field names).
const sapProblem = {
  "event.id": "-84021_1699V2",
  display_id: "P-25091",
  "event.name": "CPU saturation on erp-prod-04",
  "event.status": "ACTIVE",
  "dt.davis.is_duplicate": false,
  "dt.davis.mzs": ["SAP Production"],
  affected_entity_tags: [{ key: "app", value: "sap" }],
};

// camelCase payload — the same problem, different field naming, to prove
// extractContext() tolerates both while the mapping is still unconfirmed.
const sapProblemCamel = {
  problemId: "-84021_1699V2",
  displayId: "P-25091",
  title: "CPU saturation on erp-prod-04",
  status: "ACTIVE",
  isDuplicate: false,
  managementZones: [{ name: "SAP Production" }],
  entityTags: [{ key: "app", value: "sap" }],
};

const k8sProblem = {
  "event.id": "-99112_2288V2",
  display_id: "P-25092",
  "event.name": "Pod evicted on k8s-node-prod-11",
  "event.status": "ACTIVE",
  "dt.davis.is_duplicate": false,
  "dt.davis.mzs": ["Cloud Prod"],
  affected_entity_tags: [{ key: "platform", value: "kubernetes" }],
};

const duplicateProblem = {
  ...sapProblem,
  "event.id": "-84022_1700V2",
  display_id: "P-25093",
  "dt.davis.is_duplicate": true,
};

const closedProblem = { ...sapProblem, "event.status": "CLOSED" };

const unknownProblem = {
  "event.id": "-77777_3333V2",
  display_id: "P-25094",
  "event.name": "Disk latency on some-new-host-01",
  "event.status": "ACTIVE",
  "dt.davis.is_duplicate": false,
  "dt.davis.mzs": ["Warehouse Systems"],
  affected_entity_tags: [{ key: "app", value: "wms" }],
};

console.log("\nRouting");
check("SAP zone -> SAP Basis", decide(sapProblem).assignmentGroup, "SAP Basis");
check(
  "same problem, camelCase payload -> same group",
  decide(sapProblemCamel).assignmentGroup,
  "SAP Basis"
);
check(
  "kubernetes tag -> Cloud Platform L2",
  decide(k8sProblem).assignmentGroup,
  "Cloud Platform L2"
);
check(
  "unmatched -> Service Desk, never dropped",
  decide(unknownProblem).assignmentGroup,
  "Service Desk"
);
check(
  "unmatched is flagged as defaulted",
  decide(unknownProblem).routedBy,
  "default"
);

console.log("\nThe defect this exists to fix");
check("merged duplicate -> skipped", decide(duplicateProblem).action, "skip");
check(
  "skip names the reason",
  decide(duplicateProblem).reason,
  "merged duplicate"
);
check("non-duplicate -> incident created", decide(sapProblem).action, "create");

console.log("\nLifecycle");
check("closed problem -> resolve", decide(closedProblem).action, "resolve");
check(
  "correlation id is the problem id",
  decide(sapProblem).correlationId,
  "-84021_1699V2"
);

console.log("\nThe maintenance claim: adding an application is one line");
const before = decide(unknownProblem);
const extendedTable = [
  ...ROUTING_TABLE,
  {
    name: "Warehouse Management",
    match: { managementZone: "Warehouse Systems" },
    assignmentGroup: "WMS Support",
    category: "Application",
    impact: 2,
  },
];
const after = decide(unknownProblem, extendedTable, DEFAULT_ROUTE);
console.log(
  `  before: ${before.assignmentGroup} (${before.routedBy})` +
    `   ->   after: ${after.assignmentGroup} (${after.routedBy})`
);
check("one new entry routes it", after.assignmentGroup, "WMS Support");
check(
  "and every existing route is untouched",
  [
    decide(sapProblem, extendedTable, DEFAULT_ROUTE).assignmentGroup,
    decide(k8sProblem, extendedTable, DEFAULT_ROUTE).assignmentGroup,
  ],
  ["SAP Basis", "Cloud Platform L2"]
);

console.log("\nMalformed payload must not create uncorrelatable incidents");
check("no problem id -> error, not create", decide({}).action, "error");
check(
  "empty payload never reaches ServiceNow",
  decide({ "event.name": "something" }).action,
  "error"
);
check(
  "a problem id is enough to proceed",
  decide({ "event.id": "-1_1V2", "event.name": "x" }).action,
  "create"
);

console.log("\nOrdering");
check(
  "first match wins — specific rules must sit above general ones",
  decide(k8sProblem, [
    { name: "Catch-all infra", match: { entityTag: "platform:kubernetes" }, assignmentGroup: "Infra L1" },
    ...ROUTING_TABLE,
  ]).assignmentGroup,
  "Infra L1"
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
