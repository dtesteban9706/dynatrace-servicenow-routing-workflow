/**
 * Demo rehearsal harness.
 *
 * Walks the five demo beats from BUILD.md, showing real output from the real
 * routing logic at each one. Use it to practise the narrative and time the
 * segment before doing it live in a tenant.
 *
 *   node rehearse.js          step through, Enter to advance
 *   node rehearse.js --auto   run straight through
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { decide, ROUTING_TABLE, DEFAULT_ROUTE } from "./routing.js";

const AUTO = process.argv.includes("--auto");
const rl = AUTO ? null : createInterface({ input: stdin, output: stdout });
const started = Date.now();

const B = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const RED = (s) => `\x1b[31m${s}\x1b[0m`;

async function beat(n, title, say, body) {
  console.log(`\n${B(`── ${n}. ${title} `.padEnd(70, "─"))}\n`);
  console.log(DIM(`  SAY: ${say}\n`));
  body();
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  if (AUTO) return;
  await rl.question(DIM(`\n  [${elapsed}s elapsed — Enter to continue] `));
}

function show(label, result) {
  const line =
    result.action === "skip"
      ? GREEN(`skipped (${result.reason})`)
      : result.action === "error"
      ? RED(`error (${result.reason})`)
      : `${result.action} -> ${B(result.assignmentGroup || "-")}` +
        (result.routedBy ? DIM(`  [${result.routedBy}]`) : "");
  console.log(`  ${label.padEnd(42)} ${line}`);
}

// --- the problems used through the demo ---------------------------------

const sap = {
  "event.id": "-84021_1699V2",
  display_id: "P-25091",
  "event.name": "CPU saturation on erp-prod-04",
  "event.status": "ACTIVE",
  "dt.davis.is_duplicate": false,
  "dt.davis.mzs": ["SAP Production"],
};

const k8s = {
  "event.id": "-99112_2288V2",
  display_id: "P-25092",
  "event.name": "Pod evicted on k8s-node-prod-11",
  "event.status": "ACTIVE",
  "dt.davis.is_duplicate": false,
  affected_entity_tags: [{ key: "platform", value: "kubernetes" }],
};

// The new application — deliberately not in the table yet.
const warehouse = {
  "event.id": "-77777_3333V2",
  display_id: "P-25094",
  "event.name": "Disk latency on wms-app-02",
  "event.status": "ACTIVE",
  "dt.davis.is_duplicate": false,
  "dt.davis.mzs": ["Warehouse Systems"],
};

const merged = { ...sap, "event.id": "-84022_1700V2", display_id: "P-25093",
                 "dt.davis.is_duplicate": true };

const NEW_RULE = {
  name: "Warehouse Management",
  match: { managementZone: "Warehouse Systems" },
  assignmentGroup: "WMS Support",
  category: "Application",
  impact: 2,
};

// --- the demo ------------------------------------------------------------

console.log(B("\n  Rehearsal — one workflow, many applications"));
console.log(DIM("  Real routing logic. Same code that goes in the JS task.\n"));

await beat(
  1,
  "One workflow, not one per application",
  "This is a single workflow. It handles every application you have.",
  () => {
    console.log(`  Applications routed by this one workflow: ${B(ROUTING_TABLE.length)}`);
    ROUTING_TABLE.forEach((r) =>
      console.log(`    - ${r.name.padEnd(24)} ${DIM("->")} ${r.assignmentGroup}`)
    );
    console.log(`    ${DIM("- anything else".padEnd(26))} ${DIM("->")} ${DEFAULT_ROUTE.assignmentGroup}`);
  }
);

await beat(
  2,
  "This table is the whole of what you maintain",
  "Your alerting profiles don't change. This table is the only moving part.",
  () => {
    show("SAP problem", decide(sap));
    show("Kubernetes problem", decide(k8s));
  }
);

await beat(
  3,
  "A new application, before you do anything",
  "Here's an application the table doesn't know about. Nothing is lost — " +
    "it goes to Service Desk and is flagged as unrouted.",
  () => {
    show("Warehouse problem (not in table)", decide(warehouse));
  }
);

await beat(
  4,
  "Onboarding it — this is the entire cost",
  "I'm adding one entry. That is the whole of what onboarding an " +
    "application looks like.",
  () => {
    console.log(DIM("  + " + JSON.stringify(NEW_RULE.match) + " -> " + NEW_RULE.assignmentGroup + "\n"));
    const table = [...ROUTING_TABLE, NEW_RULE];
    show("Warehouse problem (after)", decide(warehouse, table, DEFAULT_ROUTE));
    console.log(DIM("\n  and nothing else moved:"));
    show("  SAP problem", decide(sap, table, DEFAULT_ROUTE));
    show("  Kubernetes problem", decide(k8s, table, DEFAULT_ROUTE));
  }
);

await beat(
  5,
  "The duplicate that started all this",
  "This is a problem Davis merged into another. Watch what reaches " +
    "ServiceNow: nothing. The incident is never opened, so nothing has to " +
    "be closed afterwards.",
  () => {
    show("Merged duplicate", decide(merged));
    show("The surviving problem", decide(sap));
  }
);

console.log(
  `\n${B("  Done.")} ${DIM(`${((Date.now() - started) / 1000).toFixed(0)}s total\n`)}`
);
console.log(DIM("  Beat 4 is the one that answers the objection. Don't rush it.\n"));

rl?.close();
