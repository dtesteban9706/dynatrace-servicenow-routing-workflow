/**
 * Dynatrace Workflow — JavaScript task body.
 *
 * ONE workflow serves every application. Routing is a table lookup, not a
 * separate workflow per app or per alerting profile. Adding an application is
 * one entry in ROUTING_TABLE below.
 *
 * Returns an object consumed by the downstream ServiceNow action.
 */

// ============================================================================
// ROUTING TABLE — the only part that changes when an application is added.
// First match wins, so put specific rules above general ones.
// ============================================================================

const ROUTING_TABLE = [
  {
    name: "SAP Production",
    match: { managementZone: "SAP Production" },
    assignmentGroup: "SAP Basis",
    category: "Software",
    impact: 1,
  },
  {
    name: "Storefront (web)",
    match: { managementZone: ["Storefront - Prod", "Storefront - DR"] },
    assignmentGroup: "Digital Platform L2",
    category: "Application",
    impact: 2,
  },
  {
    name: "Kubernetes platform",
    match: { entityTag: "platform:kubernetes" },
    assignmentGroup: "Cloud Platform L2",
    category: "Infrastructure",
    impact: 2,
  },
  {
    name: "EDI gateway",
    match: { entityTag: "app:edi", titleMatches: "(?i)saturation|unavailable" },
    assignmentGroup: "Integration Services",
    category: "Application",
    impact: 2,
  },
  // <-- Adding the next application is a single entry here.
];

// Anything that matches no rule still gets an incident — it is never dropped.
const DEFAULT_ROUTE = {
  name: "Unrouted",
  assignmentGroup: "Service Desk",
  category: "Inquiry",
  impact: 3,
};

// ============================================================================
// Payload mapping — THE ONE PLACE TO FIX if field names differ.
// The Davis problem event payload shape was not verifiable ahead of time, so
// each field is read from several plausible locations. Confirm against a real
// payload (run the workflow once, inspect the trigger output) and then delete
// the branches you do not need.
// ============================================================================

function extractContext(event) {
  const first = (...candidates) =>
    candidates.find((v) => v !== undefined && v !== null && v !== "");

  const asArray = (v) => (v === undefined || v === null ? [] : [].concat(v));

  return {
    problemId: first(event["event.id"], event.problemId, event.id),
    displayId: first(event["display_id"], event.displayId, event.problemDisplayId),
    title: first(event["event.name"], event.title, event["event.description"], ""),
    status: String(first(event["event.status"], event.status, "ACTIVE")).toUpperCase(),
    severity: first(event["event.category"], event.severityLevel, ""),
    isDuplicate:
      first(event["dt.davis.is_duplicate"], event.isDuplicate, false) === true,
    managementZones: asArray(
      first(event["dt.davis.mzs"], event.managementZones, event.managementZone, [])
    ).map((z) => (typeof z === "object" ? z.name : z)),
    tags: asArray(first(event["affected_entity_tags"], event.entityTags, [])).map(
      (t) =>
        typeof t === "object"
          ? t.value
            ? `${t.key}:${t.value}`
            : t.key
          : String(t)
    ),
    entityName: first(
      event["affected_entity_name"],
      event.affectedEntityName,
      ""
    ),
  };
}

// ============================================================================
// Routing — pure, so it can be tested outside Dynatrace.
// ============================================================================

function matchesRule(ctx, match) {
  if (match.managementZone) {
    const wanted = [].concat(match.managementZone);
    if (!ctx.managementZones.some((z) => wanted.includes(z))) return false;
  }

  if (match.entityTag) {
    const wanted = [].concat(match.entityTag);
    if (!ctx.tags.some((t) => wanted.includes(t))) return false;
  }

  if (match.titleMatches) {
    // Support an inline (?i) prefix for case-insensitive matching.
    let pattern = match.titleMatches;
    let flags = "";
    if (pattern.startsWith("(?i)")) {
      pattern = pattern.slice(4);
      flags = "i";
    }
    if (!new RegExp(pattern, flags).test(ctx.title)) return false;
  }

  if (match.severity) {
    const wanted = [].concat(match.severity);
    if (!wanted.includes(ctx.severity)) return false;
  }

  // An empty match object would catch everything; DEFAULT_ROUTE is the way to
  // express that, so treat it as a misconfiguration rather than a wildcard.
  return Object.keys(match).length > 0;
}

function resolveRoute(ctx, table, fallback) {
  for (const rule of table) {
    if (matchesRule(ctx, rule.match)) return rule;
  }
  return fallback;
}

// ============================================================================
// Decision
// ============================================================================

function decide(event, table = ROUTING_TABLE, fallback = DEFAULT_ROUTE) {
  const ctx = extractContext(event);

  // The defect this workflow exists to fix: Davis merges duplicate problems
  // after the fact, and the classic integration cannot retract the incident it
  // already opened. Filtering here means it is never opened.
  if (ctx.isDuplicate) {
    return {
      action: "skip",
      reason: "merged duplicate",
      problemId: ctx.problemId,
      displayId: ctx.displayId,
    };
  }

  // No problem ID means nothing to correlate on, and an uncorrelated incident
  // is exactly the duplicate this workflow exists to prevent — every update to
  // the problem would open another ticket. During the period where the payload
  // mapping is still unconfirmed this is the likely symptom of a wrong field
  // name, so surface it as its own outcome rather than quietly creating junk.
  // Wire this branch to a notification or log task, NOT to incident creation.
  if (!ctx.problemId) {
    return {
      action: "error",
      reason: "no problem id on payload — check extractContext() mapping",
      title: ctx.title,
    };
  }

  const route = resolveRoute(ctx, table, fallback);

  if (ctx.status === "CLOSED" || ctx.status === "RESOLVED") {
    return {
      action: "resolve",
      problemId: ctx.problemId,
      displayId: ctx.displayId,
      correlationId: ctx.problemId,
      closeNotes: `Dynatrace problem ${ctx.displayId || ctx.problemId} closed.`,
      route: route.name,
    };
  }

  return {
    action: "create",
    problemId: ctx.problemId,
    displayId: ctx.displayId,
    correlationId: ctx.problemId,
    shortDescription: ctx.title,
    assignmentGroup: route.assignmentGroup,
    category: route.category,
    impact: route.impact,
    route: route.name,
    routedBy: route === fallback ? "default" : "table",
  };
}

// === BUILD:STRIP-BELOW ======================================================
// Everything past this marker is replaced by build_workflow.js when generating
// workflow.json. It exists so the logic above can be tested locally.
// ============================================================================

export default async function (params) {
  const event = params?.event ?? {};
  return decide(event);
}

export {
  decide,
  resolveRoute,
  matchesRule,
  extractContext,
  ROUTING_TABLE,
  DEFAULT_ROUTE,
};
