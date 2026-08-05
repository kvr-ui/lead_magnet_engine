// Pure client-side helpers for rendering task 10's per-node funnel
// (`GET /api/campaigns/:id/node-funnel`) on the flow canvas (task 13/#41).
//
// Kept out of FlowCanvas.jsx on purpose: the endpoint's own comment says it's
// "deliberately a dumb counter: no edge topology, no drop-off percentages" and
// leaves that to "whichever caller composes these into something" — this
// module is that composition, and living apart from the component lets it be
// exercised directly instead of only through a rendered canvas.

// The date task 4 (CampaignNodeVisit, the thing that actually records a node
// visit) shipped. Nothing before this point was ever recorded and none of it
// can be recovered — every view built on the funnel has to say so rather than
// let a zero or a low count be misread as "nobody visited" when the truth may
// be "nobody was counted yet".
export const NODE_VISIT_TRACKING_SINCE = "2026-08-05";

export const NODE_VISIT_TRACKING_NOTE =
  `Counts reflect activity recorded since node-visit tracking began on ${NODE_VISIT_TRACKING_SINCE}. ` +
  "Activity before that date was never recorded and can't be recovered.";

// nodeId -> that node's funnel row, for O(1) lookup while walking the canvas's
// own node list. Empty when there is no funnel yet (still loading, fetch
// failed, or the campaign has never been published) — callers treat a miss
// the same way whether the map is empty or just missing one id, which is what
// lets a fetch failure fall back to "no badges" instead of needing its own
// code path everywhere this is read.
export function funnelByNodeId(funnel) {
  const map = new Map();
  if (funnel && Array.isArray(funnel.nodes)) {
    for (const node of funnel.nodes) map.set(node.nodeId, node);
  }
  return map;
}

// nodeId -> reached count, for the edge drop-off math below. Deliberately a
// separate map from funnelByNodeId rather than reading `.reached` off it at
// each call site — this is the one number edge math needs, and keeping it
// its own map makes edgeDropoff's contract ("give me two counts") obvious
// without pulling the whole per-node row through it.
export function reachedById(funnel) {
  const map = new Map();
  if (funnel && Array.isArray(funnel.nodes)) {
    for (const node of funnel.nodes) map.set(node.nodeId, node.reached || 0);
  }
  return map;
}

// One edge's drop-off, computed purely from the reached count of the two
// nodes it connects. Returns null when there's nothing to say: either side
// has no funnel data at all (the graph version fetched doesn't recognise the
// node — e.g. a node added to the draft since the last publish), or the
// source was never reached by anyone, which would make a percentage
// meaningless (division by zero).
//
// This is intentionally not an exact "how many leads took this specific
// edge" — the funnel endpoint has no way to attribute a lead's arrival at a
// node with more than one incoming edge to any one of them, and computing
// that precisely would mean walking the graph (topology math), which is
// exactly what the endpoint's own comment says stays out of it. This reports
// the coarser, always-available number instead: how much smaller the
// target's reached count is than the source's.
export function edgeDropoff(reachedByNodeId, sourceId, targetId) {
  const from = reachedByNodeId.get(sourceId);
  const to = reachedByNodeId.get(targetId);
  if (from === undefined || to === undefined || from === 0) return null;
  const dropped = Math.max(0, from - to);
  return { from, to, dropped, pct: Math.round((dropped / from) * 100) };
}

// A note about enrollments pinned to some other graph version, or null when
// there are none. Deliberately never folded into any node's badge — those
// leads are walking a different graph, one that may not even have the same
// nodes, so their numbers can't be attributed to a node in the version being
// viewed without lying about what happened where.
export function otherVersionsNote(funnel) {
  const count = funnel && funnel.otherVersions && funnel.otherVersions.count;
  if (!count) return null;
  return (
    `${count} enrollment${count === 1 ? " is" : "s are"} pinned to a different graph version ` +
    "and not reflected in the counts below."
  );
}
