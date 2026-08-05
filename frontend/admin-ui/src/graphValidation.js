// Pure, dependency-free inspection of a campaign flow graph
// (`{ nodes, edges }`, in the shape `campaign.draft` uses — see FlowCanvas.jsx's
// toDomainGraph()). No React, no network calls: this module only reads the
// graph it is handed and returns what it found.
//
// Every rule here is a port of behaviour the backend already enforces or
// already exhibits at runtime, not an invented one:
//
//   backend/node/models/Campaign.js's graphIntegrityErrors() — duplicate node
//   ids and edges pointing at nodes that don't exist. These run as Mongoose
//   validators on save, so they are the two rules that block *saving a draft*
//   as well as publishing — everything else here leaves a half-built flow
//   saveable, exactly as the backend does.
//
//   backend/node/lib/campaignTargets.js's sourceEntryPoints() — the checks
//   that throw at enrollment time: no source node, a source with no sourceId,
//   a source with no outgoing edge. A source with no map.phone is folded in
//   alongside these (see FlowCanvas.jsx's isSourceInvalid(), the one existing
//   canvas-side rule this module is written to absorb — task 4 drops that
//   check once this module is wired in).
//
//   backend/node/lib/campaignEngine.js's per-kind config gaps — the ones that
//   make the walker park a lead rather than throw (a disabled action, a split
//   with no ratio, a goal with no threshold, ...). Each is a warning here: it
//   never blocks saving or publishing, it just tells the admin a lead reaching
//   that node today would stall.
//
// Nothing here re-derives a rule from first principles — if it isn't observed
// backend behaviour, it isn't in this file.

// A node's operator-facing name: its label when it has one, its id otherwise.
// Every message this module writes names a node this way, per the "Source
// \"CA Guru\" has no phone mapping", not "config.map.phone undefined" rule —
// these are read by whoever is looking at the canvas, not at the code.
function displayName(node) {
  const label = node && typeof node.label === "string" ? node.label.trim() : "";
  if (label) return label;
  return (node && node.id) || "this node";
}

function idOf(node) {
  return node && node.id ? node.id : undefined;
}

// blocksSave: true for the two integrity rules Mongoose enforces on every
// save (duplicate ids, dangling edges); false for everything else, which the
// backend only rejects at publish/enroll time and which must therefore stay
// saveable. Every error, blocksSave or not, blocks *publishing* — that is
// what makes it an error rather than a warning.
function pushError(errors, node, message, { blocksSave = false } = {}) {
  errors.push({ nodeId: idOf(node), message, blocksSave });
}

function pushWarning(warnings, node, message) {
  warnings.push({ nodeId: idOf(node), message });
}

// Mirrors campaignEngine.js's conditionFilterFor(): a condition node's "field"
// kind is satisfied by a non-empty `filter` object on its own, in which case
// the separate field/operator/value keys are never read and have nothing to
// warn about.
function conditionUsesFilterObject(config) {
  return Boolean(
    config.filter && typeof config.filter === "object" && !Array.isArray(config.filter) && Object.keys(config.filter).length > 0
  );
}

function isBlank(value) {
  return value === undefined || value === null || value === "";
}

// Mirrors campaignEngine.js's resolveWaitAt(): an amount is only "set" once
// it parses to a finite number. An explicit 0 is a real (if odd) wait, not a
// gap, so it is left alone.
function hasWaitAmount(config) {
  if (isBlank(config.amount)) return false;
  return Number.isFinite(Number(config.amount));
}

// Mirrors campaignEngine.js's splitBranchFor(): ratio must parse to a finite
// number between 0 and 100 inclusive, or the walker parks the lead rather
// than guess.
function hasValidSplitRatio(config) {
  if (isBlank(config.ratio)) return false;
  const ratio = Number(config.ratio);
  return Number.isFinite(ratio) && ratio >= 0 && ratio <= 100;
}

// Mirrors campaignEngine.js's actionModeFor(): an action is either an HTTP
// call (needs a url) or a source write-back (needs a field). Neither present
// means performAction() has nothing to do and the walker parks the lead.
function hasActionTarget(config) {
  return Boolean(config.url) || Boolean(config.field);
}

/**
 * Inspect a campaign flow graph and report what's wrong with it.
 *
 * @param {{nodes?: Array, edges?: Array}} graph - the shape `campaign.draft`
 *   (and every entry of `campaign.versions`) uses.
 * @returns {{errors: Array<{nodeId: (string|undefined), message: string, blocksSave: boolean}>,
 *            warnings: Array<{nodeId: (string|undefined), message: string}>}}
 *   `errors` block publishing; those with `blocksSave: true` also block
 *   saving a draft, mirroring the two Mongoose validators the backend runs on
 *   every save. `warnings` never block anything — they describe a lead that
 *   would stall or fail once it reached that node, nothing more.
 */
export function validateGraph(graph) {
  const nodes = (graph && graph.nodes) || [];
  const edges = (graph && graph.edges) || [];
  const errors = [];
  const warnings = [];

  // --- structural integrity (Campaign.js's graphIntegrityErrors) -----------
  // Mirrored exactly, including that duplicate ids and dangling edges are the
  // only two rules that also block a draft save.

  const nodesById = new Map(); // id -> [nodes with that id], first-seen order
  for (const node of nodes) {
    if (!node || !node.id) continue;
    if (!nodesById.has(node.id)) nodesById.set(node.id, []);
    nodesById.get(node.id).push(node);
  }

  for (const [id, group] of nodesById) {
    if (group.length < 2) continue;
    const names = group.map((n) => displayName(n));
    pushError(errors, { id }, `${names.length} nodes share the id "${id}" (${names.join(", ")}) — node ids must be unique.`, {
      blocksSave: true,
    });
  }

  const idSet = new Set(nodesById.keys());
  const firstNodeById = (id) => {
    const group = nodesById.get(id);
    return group && group[0];
  };

  for (const edge of edges) {
    if (!edge) continue;
    const fromExists = Boolean(edge.from) && idSet.has(edge.from);
    const toExists = Boolean(edge.to) && idSet.has(edge.to);
    if (!fromExists) {
      const toNode = toExists ? firstNodeById(edge.to) : undefined;
      const into = toNode ? ` into "${displayName(toNode)}"` : "";
      pushError(errors, toNode, `A connection${into} starts at a node that no longer exists in the flow.`, { blocksSave: true });
    }
    if (!toExists) {
      const fromNode = fromExists ? firstNodeById(edge.from) : undefined;
      const outOf = fromNode ? `The connection out of "${displayName(fromNode)}"` : "A connection";
      pushError(errors, fromNode, `${outOf} points at a node that no longer exists in the flow.`, { blocksSave: true });
    }
  }

  // --- entry points (campaignTargets.js's sourceEntryPoints), plus the
  // existing canvas rule that a source needs a phone mapping -----------------

  const hasOutboundEdge = new Set(edges.filter((e) => e && e.from).map((e) => e.from));
  const hasInboundEdge = new Set(edges.filter((e) => e && e.to).map((e) => e.to));

  let sourceCount = 0;
  for (const node of nodes) {
    if (!node || node.kind !== "source") continue;
    sourceCount++;
    const config = node.config || {};
    const name = displayName(node);

    if (!config.sourceId) {
      pushError(errors, node, `Source "${name}" has no source selected.`);
    }
    if (!config.map || !config.map.phone) {
      pushError(errors, node, `Source "${name}" has no phone mapping.`);
    }
    if (!hasOutboundEdge.has(node.id)) {
      pushError(errors, node, `Source "${name}" is not connected to anything — wire it to the node its leads should start on.`);
    }
  }
  if (sourceCount === 0) {
    pushError(errors, undefined, "This flow has no source node. Add one before it can be published.");
  }

  // --- per-kind config gaps (campaignEngine.js's park-not-throw cases) -----
  // Warnings only: none of these block saving or publishing, they just say a
  // lead reaching that node today would stall or fail.

  for (const node of nodes) {
    if (!node) continue;
    const config = node.config || {};
    const name = displayName(node);

    switch (node.kind) {
      case "message":
        if (!config.templateId) {
          pushWarning(warnings, node, `Message "${name}" has no template selected — leads reaching it will fail to send.`);
        }
        break;

      case "wait":
        if (!hasWaitAmount(config)) {
          pushWarning(warnings, node, `Wait "${name}" has no amount set.`);
        }
        if (!config.unit) {
          pushWarning(warnings, node, `Wait "${name}" has no unit set.`);
        }
        break;

      case "split":
        if (!hasValidSplitRatio(config)) {
          pushWarning(warnings, node, `Split "${name}" has no valid ratio set (0-100) — leads reaching it will be parked.`);
        }
        break;

      case "condition": {
        const on = (config.on || "field").toLowerCase();
        if (on === "field" && !conditionUsesFilterObject(config)) {
          if (!config.field) {
            pushWarning(warnings, node, `Condition "${name}" has no field to compare.`);
          }
          if (isBlank(config.operator)) {
            pushWarning(warnings, node, `Condition "${name}" has no operator set.`);
          }
          if (isBlank(config.value)) {
            pushWarning(warnings, node, `Condition "${name}" has no value set.`);
          }
        }
        break;
      }

      case "goal": {
        const threshold = config.threshold === undefined ? config.count : config.threshold;
        if (isBlank(threshold)) {
          pushWarning(warnings, node, `Goal "${name}" has no threshold set.`);
        }
        break;
      }

      case "action":
        if (!hasActionTarget(config)) {
          pushWarning(warnings, node, `Action "${name}" has neither a URL nor a source field set — leads reaching it will fail.`);
        }
        if (config.enabled !== true) {
          pushWarning(warnings, node, `Action "${name}" is disabled — leads reaching it will be parked until it's switched on.`);
        }
        break;

      default:
        break;
    }

    // Orphan check applies to every kind except source: a source is meant to
    // be where leads *enter* the graph, so having no inbound edge is its
    // normal state rather than a problem.
    if (node.kind !== "source" && node.id && !hasInboundEdge.has(node.id)) {
      pushWarning(warnings, node, `"${name}" has no connection leading into it, so no lead can ever reach it.`);
    }
  }

  return { errors, warnings };
}
