/**
 * Generates workflow.json from routing.js.
 *
 * The JS task body has to be embedded as a JSON string. Generating it means the
 * workflow can never drift from the logic that `npm test` covers.
 *
 *   node build_workflow.js
 *
 * Schema per Dynatrace-workflow-samples/AGENTS.md (schemaVersion 3).
 * Action identifiers per the ServiceNow connector docs and workflow-samples PR #41.
 */

import { readFileSync, writeFileSync } from "node:fs";

const CONNECTION = "REPLACE_WITH_SERVICENOW_CONNECTION_ID";

// --- build the JS task body ------------------------------------------------

const source = readFileSync("routing.js", "utf8");
const marker = "// === BUILD:STRIP-BELOW";
const logic = source.slice(0, source.indexOf(marker)).trimEnd();

if (!source.includes(marker)) {
  throw new Error("BUILD:STRIP-BELOW marker missing from routing.js");
}

// The Dynatrace entrypoint. Run JavaScript tasks receive executionId; the
// event is reached through the automation-utils SDK. Both accessor shapes are
// tried because the exact one is unconfirmed — see VERIFY in BUILD.md.
const entrypoint = `

// === generated entrypoint (build_workflow.js) ==============================

async function loadEvent(executionId) {
  try {
    const { execution } = await import("@dynatrace-sdk/automation-utils");
    const ex = await execution(executionId);
    const ev = typeof ex.event === "function" ? await ex.event() : ex.event;
    if (ev) return ev;
  } catch (e) {
    console.log("could not load event from execution context: " + e);
  }
  return {};
}

export default async function ({ executionId }) {
  const event = await loadEvent(executionId);
  const decision = decide(event);
  console.log("routing decision: " + JSON.stringify(decision));
  return decision;
}
`;

const script = logic + entrypoint;

// --- the workflow ----------------------------------------------------------

const workflow = {
  title: "ServiceNow incidents — single workflow, table-driven routing",
  description:
    "One workflow for every application. Assignment-group routing is a lookup " +
    "table inside the route_incident task; adding an application is one entry " +
    "in it. Merged duplicate problems are filtered before any incident is opened.",
  schemaVersion: 3,

  trigger: {
    eventTrigger: {
      isActive: true,
      // Deliberately does NOT filter duplicates here. The JS task does that, so
      // a merged duplicate still produces an execution you can point at in the
      // log — useful in a demo, and it keeps the filter in one tested place.
      filterQuery: 'event.kind == "DAVIS_PROBLEM"',
      triggerConfiguration: {
        type: "event",
        value: {
          eventType: "events",
          query: 'event.kind == "DAVIS_PROBLEM"',
        },
      },
    },
  },

  tasks: {
    route_incident: {
      name: "route_incident",
      description:
        "Decide create / resolve / skip, and which assignment group applies.",
      action: "dynatrace.automations:run-javascript",
      input: { script },
      position: { x: 0, y: 1 },
      predecessors: [],
    },

    find_existing: {
      name: "find_existing",
      description: "Look for an incident already correlated to this problem.",
      action: "dynatrace.servicenow:snow-search-incidents",
      input: {
        connectionId: CONNECTION,
        sysparmQuery:
          "correlation_id={{ result('route_incident').correlationId }}",
        sysparmFields: "number,sys_id,state,correlation_id",
        sysparmLimit: 1,
      },
      position: { x: 0, y: 2 },
      predecessors: ["route_incident"],
      conditions: {
        states: { route_incident: "OK" },
        custom:
          "{{ result('route_incident').action in ['create', 'resolve'] }}",
        else: "SKIP",
      },
    },

    create_incident: {
      name: "create_incident",
      description: "Open an incident, routed by the table.",
      action: "dynatrace.servicenow:snow-create-incident",
      input: {
        connectionId: CONNECTION,
        correlationId: "{{ result('route_incident').correlationId }}",
        shortDescription: "{{ result('route_incident').shortDescription }}",
        description:
          "Dynatrace problem {{ result('route_incident').displayId }}\n" +
          "Routed by: {{ result('route_incident').route }}",
        assignmentGroup: "{{ result('route_incident').assignmentGroup }}",
        category: "{{ result('route_incident').category }}",
        impact: "{{ result('route_incident').impact }}",
      },
      position: { x: -1, y: 3 },
      predecessors: ["find_existing"],
      conditions: {
        states: { find_existing: "OK" },
        // VERIFY the search-result accessor against a real run.
        custom:
          "{{ result('route_incident').action == 'create' and " +
          "result('find_existing').records | length == 0 }}",
        else: "SKIP",
      },
    },

    resolve_incident: {
      name: "resolve_incident",
      description: "Close the incident when the problem closes.",
      action: "dynatrace.servicenow:snow-resolve-incident",
      input: {
        connectionId: CONNECTION,
        number: "{{ result('find_existing').records[0].number }}",
        resolutionCode: "Solved (Permanently)",
        resolutionNotes: "{{ result('route_incident').closeNotes }}",
      },
      position: { x: 1, y: 3 },
      predecessors: ["find_existing"],
      conditions: {
        states: { find_existing: "OK" },
        // VERIFY the search-result accessor against a real run.
        custom:
          "{{ result('route_incident').action == 'resolve' and " +
          "result('find_existing').records | length > 0 }}",
        else: "SKIP",
      },
    },

    flag_mapping_error: {
      name: "flag_mapping_error",
      description:
        "Payload carried no problem id. Never create an incident here — " +
        "without a correlation id every update opens another ticket.",
      action: "dynatrace.automations:run-javascript",
      input: {
        script:
          'export default async function () {\n' +
          '  console.log("ROUTING ERROR: no problem id on the event payload. " +\n' +
          '    "Fix extractContext() in the route_incident task.");\n' +
          '  return { alerted: true };\n' +
          '}\n',
      },
      position: { x: 0, y: 3 },
      predecessors: ["route_incident"],
      conditions: {
        states: { route_incident: "OK" },
        custom: "{{ result('route_incident').action == 'error' }}",
        else: "SKIP",
      },
    },
  },
};

writeFileSync("workflow.json", JSON.stringify(workflow, null, 2) + "\n");

const bytes = JSON.stringify(workflow).length;
console.log(
  `workflow.json written — ${Object.keys(workflow.tasks).length} tasks, ` +
    `${(bytes / 1024).toFixed(1)} KB, script ${script.length} chars`
);
console.log(`Remember to replace ${CONNECTION} before import.`);
