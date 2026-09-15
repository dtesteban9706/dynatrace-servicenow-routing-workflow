# Single-workflow routing demo — build sheet

## The argument this makes

The usual objection to workflows is that they mean building and maintaining a
separate workflow per application and per alerting profile. This demonstrates
that they don't: **one** workflow serves every application, and routing is a
table lookup inside it. Adding an application is one entry in that table.

Their existing alerting profiles stay exactly as they are.

## workflow.json

```bash
node build_workflow.js
```

Generates `workflow.json` from `routing.js`, so the imported workflow can never
drift from the logic `npm test` covers. Re-run it after any edit to the routing
table.

Schema (`schemaVersion: 3`, trigger/tasks/conditions shape) is taken from the
Dynatrace workflow-samples `AGENTS.md`; the ServiceNow action identifiers and
their input keys from the connector docs and workflow-samples PR #41. Five
tasks: `route_incident` (JS), `find_existing`, `create_incident`,
`resolve_incident`, `flag_mapping_error`.

### Replace before importing

`REPLACE_WITH_SERVICENOW_CONNECTION_ID` appears in four tasks — set it to your
ServiceNow connection ID.

### VERIFY on the first run

Three things could not be confirmed without a tenant that has Davis problems and
a ServiceNow connection. Each is isolated so it is cheap to fix:

1. **The event accessor.** `loadEvent()` in the generated script tries both
   `ex.event()` and `ex.event` from the automation-utils SDK. If neither works
   the task logs it and `decide()` returns `action: "error"` rather than
   creating junk — so the failure is visible, not silent.
2. **The payload field names.** `extractContext()` reads each field from several
   plausible locations. Check a real payload, then delete the branches you don't
   need. This is the one place field-name surprises need fixing.
3. **The search-result accessor.** `create_incident` and `resolve_incident`
   condition on `result('find_existing').records | length`. The shape that
   `snow-search-incidents` actually returns is unconfirmed — both conditions are
   commented `VERIFY` in `build_workflow.js`. Get it wrong and the task simply
   skips; it does not misfire.

### A note on the trigger filter

The trigger filters on `event.kind == "DAVIS_PROBLEM"` only — it deliberately
does *not* exclude duplicates. The JS task does that, which means a merged
duplicate still produces an execution you can point at in the log. That is
better for the demo (you can show the skip happening) and keeps duplicate
filtering in the one place that has tests around it.

If you prefer to filter at the trigger, use a null-safe form — see below. The
JS task already handles nulls correctly: `extractContext()` falls back to
`false` when the field is missing, so an absent flag means "not a duplicate"
and the incident is still created.

## Prerequisites

- **ServiceNow Connector for Workflows.** Confirm it is installed and whether it
  is still Preview in the target tenant — that materially changes how hard you
  can push it as the recommended path.
- A ServiceNow connection with permission to create and resolve incidents.
- A non-production alerting profile and a test assignment group.

## Build steps

### 1. Trigger — Davis problem event

Use the event trigger with a custom filter:

```
event.kind == "DAVIS_PROBLEM"
```

Filter expressions are capped at 1,000 characters.

#### If you filter duplicates at the trigger, mind the null semantics

DQL is three-valued: a comparison against a null field returns **null, not
false**, and `not` propagates that null rather than inverting it. So these three
are equivalent, and all of them drop records where the field is absent:

```
dt.davis.is_duplicate == false
not dt.davis.is_duplicate == true
dt.davis.is_duplicate != true
```

Measured on 430,175 records carrying a boolean that is true on 14,917, false on
44,537 and absent on 370,721: each of the three forms above matched exactly
44,537 — the explicit-false rows only. The null rows matched none of them.

If `dt.davis.is_duplicate` turns out to be absent rather than explicitly false
on a non-duplicate problem, any of those filters would silence the workflow
entirely. The null-safe forms both matched 415,258 (explicit false + absent):

```
isNull(dt.davis.is_duplicate) or dt.davis.is_duplicate == false
coalesce(dt.davis.is_duplicate, false) == false
```

Whether the trigger's filter expression accepts `isNull()` / `coalesce()` is
unverified — check in the UI. This is a further reason the shipped workflow
filters duplicates in the JS task instead, where the fallback is explicit and
covered by tests.

### 2. JavaScript task — `route_incident`

Paste the whole of `routing.js`.

Before it will run you must confirm one thing in the UI: **how a JavaScript task
reaches the triggering event.** `event()` is the documented *expression* form;
inside JavaScript it is the automation-utils SDK. The two commented lines at the
bottom of `routing.js` are where that goes.

Then check a real payload against `extractContext()` — it reads each field from
several plausible locations precisely because the shape is unconfirmed. Once
you've seen a real event, delete the branches that don't apply. That function is
the single place field-name surprises need fixing.

### 3. ServiceNow action — `create_incident`

Condition: run only when `route_incident` returned `action == "create"`.

Map the fields from the task result:

| ServiceNow field | From |
|---|---|
| Short description | `result('route_incident')['shortDescription']` |
| Assignment group | `result('route_incident')['assignmentGroup']` |
| Category | `result('route_incident')['category']` |
| Impact | `result('route_incident')['impact']` |
| Correlation ID | `result('route_incident')['correlationId']` |

Correlation ID must be the Dynatrace problem ID — that is what lets updates land
on the existing incident instead of opening a new one.

### 4. ServiceNow action — `resolve_incident`

Condition: `action == "resolve"`. Look the incident up by correlation ID and
close it with `closeNotes`.

### 5. Nothing for `action == "skip"`

A merged duplicate produces no ServiceNow activity at all. That is the fix: the
incident is never opened, so nothing has to be retracted later.

### 6. Handle `action == "error"` — do not skip this

If the payload carries no problem ID, `routing.js` returns `action: "error"`
instead of creating an incident. Wire this to a notification or a log task —
**never to incident creation.**

Without a problem ID there is nothing to set Correlation ID to, and an
uncorrelated incident means every subsequent update to that problem opens
another ticket. That is precisely the duplicate behaviour being fixed. While the
payload mapping is unconfirmed, a wrong field name in `extractContext()` would
otherwise show up as a flood of uncorrelatable incidents; this makes it show up
as a visible error on the first execution instead.

## Two layers of duplicate filtering, on purpose

The trigger filter stops duplicates before the workflow runs. `routing.js`
checks again. That is deliberate — if the trigger filter is ever edited or the
field name turns out to be different, the JS guard still holds, and the skip
reason shows up in the execution log rather than silently creating incidents.

## Verify before demoing

- [ ] ServiceNow connector installed; note whether it is Preview
- [ ] Trigger fires on a real problem (check `not ... == true` behaves)
- [ ] `extractContext()` matches a real payload — management zones and tags in
      particular, since those are what routing keys on
- [ ] An incident lands in ServiceNow with the right assignment group
- [ ] A closed problem resolves the incident
- [ ] A merged duplicate produces nothing
- [ ] The `error` branch is wired to a notification, not to incident creation

Run `npm test` after any edit to the routing table — 16 checks, including that
adding an entry doesn't disturb existing routes.

## Picking a tenant to rehearse in

The workflow needs somewhere to live, and not every environment will do.

**What the rehearsal needs:** a tenant where you can create workflows, that has a
ServiceNow connection (a sandbox instance is fine — better, in fact), and where
either real Davis problems occur or you can execute the workflow manually with a
supplied payload.

**A demo tenant that only generates logs will not work.** No monitored entities
means no Davis problems, no management zones and no entity tags — the trigger
never fires and the routing table matches nothing. Check before you invest the
setup time:

```
fetch dt.davis.problems, from: now() - 30d | summarize count()
```

If that returns zero, pick a different tenant or plan to drive the demo by
manual execution.

### Rehearsing by manual execution

`sample-events.json` holds five payloads — routed, unrouted, duplicate, closed,
and a Kubernetes-tagged one. Run the workflow manually with each as input and
check the JS task output matches what `node rehearse.js` shows locally.

Confirm in the UI how a manual run accepts an input payload; that mechanism
isn't verified here.

### Rehearsing with no tenant at all

```bash
node rehearse.js          # step through, Enter to advance
node rehearse.js --auto   # straight through
```

Same routing code as the JS task, so the output is real. It won't prove the
trigger or the ServiceNow action work — but it does let you practise the
narrative and time the segment.

## Demo script for the call

1. Show the workflow — **one** workflow, four applications already routed.
2. Show `ROUTING_TABLE`. This is the whole of what the customer maintains.
3. Trigger a test problem in an unrouted zone — it lands with Service Desk,
   flagged as defaulted. Nothing is ever dropped.
4. Add one entry for that zone. Re-trigger. It routes to the right group.
   **That is the entire cost of onboarding an application.**
5. Trigger a duplicate — nothing reaches ServiceNow. Show the skip in the
   execution log.

Step 4 is the one that answers Shalini's objection. Don't let it get buried.

## What this does not solve

Incidents already open in ServiceNow for problems Davis has since merged. This
workflow prevents new ones; it does not clean up the backlog. That is a separate
reconciliation job, and worth raising as a distinct piece of work rather than
implying this covers it.
