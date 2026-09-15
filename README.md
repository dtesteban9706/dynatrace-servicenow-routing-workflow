# Table-driven ServiceNow routing — one Dynatrace workflow, many applications

A single Dynatrace workflow that creates ServiceNow incidents for every
application, with assignment-group routing handled by a lookup table inside it.
Onboarding an application is one entry in that table — not a new workflow.

## The problem it solves

Davis opens several problems for one underlying issue — a burst of CPU
saturation events on the same host, for example. Each fires its own notification
through the alerting profile, and the 2nd-gen (classic) ServiceNow integration
creates one incident per Problem ID.

When Davis later merges those problems together, the classic integration has no
mechanism to go back into ServiceNow and close or link the incidents it already
opened. The result is several incidents for one issue, most of them orphaned.

This workflow filters merged duplicates **before** any incident is opened, so
there is nothing to retract afterwards.

It also answers the objection that usually follows: *"moving to workflows means
maintaining one per application and per alerting profile."* It doesn't. One
workflow, one routing table, and existing alerting profiles stay untouched.

## Quick start

```bash
npm test                  # 16 checks on the routing logic
node rehearse.js          # step through the five demo beats
node build_workflow.js    # generate workflow.json from routing.js
```

No dependencies. Node 18+.

## The routing table

The only part that changes when an application is added, at the top of
[`routing.js`](routing.js):

```js
const ROUTING_TABLE = [
  { name: "SAP Production",
    match: { managementZone: "SAP Production" },
    assignmentGroup: "SAP Basis", category: "Software", impact: 1 },

  { name: "Kubernetes platform",
    match: { entityTag: "platform:kubernetes" },
    assignmentGroup: "Cloud Platform L2", category: "Infrastructure", impact: 2 },

  // <-- Adding the next application is a single entry here.
];
```

Matches on management zone, entity tag, title regex, or severity. First match
wins, so specific rules go above general ones. Anything matching no rule still
raises an incident against a default group — nothing is silently dropped.

> The zone and assignment-group names in this repo are **illustrative**.
> Replace them with real values before showing this to anyone.

## Files

| File | |
|---|---|
| `routing.js` | Routing table + decision logic. Becomes the JS task body. |
| `test_routing.js` | 16 checks, including that adding an entry disturbs nothing else. |
| `build_workflow.js` | Generates `workflow.json` from `routing.js`. |
| `workflow.json` | Generated. Import into the Workflows app. |
| `rehearse.js` | Demo walkthrough — practise the narrative, time the segment. |
| `sample-events.json` | Five Davis problem payloads for manual workflow runs. |
| `BUILD.md` | **Full build, verification and demo instructions.** |

`workflow.json` is generated rather than hand-written, so the imported workflow
can never drift from the logic the tests cover. Re-run `build_workflow.js` after
editing the routing table.

## Status

**Tested:** the routing logic, end to end, on synthetic payloads. The generated
`workflow.json` is valid JSON, carries a valid JS task body, and uses schema and
action identifiers taken from Dynatrace's own workflow samples and connector
docs (sources in `BUILD.md`).

**Not yet verified against a live tenant:** the event accessor, the Davis
payload field names, and the shape returned by `snow-search-incidents`. All
three are isolated and fail safe — see the VERIFY section in
[`BUILD.md`](BUILD.md). Do not skip it.

## Scope

Prevents *new* duplicate incidents. Does **not** retrospectively close incidents
already open for problems Davis has since merged — that backlog needs a separate
reconciliation job.
