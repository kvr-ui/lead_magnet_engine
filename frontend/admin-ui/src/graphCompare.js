// "Does the draft still match what is live?" — asked by the campaign status
// strip (CampaignStatus.jsx), which uses the answer to describe the mismatch,
// and by the send panel (AudienceSendPanel.jsx), which uses it to warn that
// Send acts on the published version rather than on the canvas. One answer,
// two callers: a second copy is how the two would start disagreeing about the
// same campaign.
//
// Intentionally not shared with FlowCanvas.jsx, which has its own
// position-*inclusive* comparison gating the Publish button. That one has to
// treat "a node was dragged" as a change worth publishing; these two must not,
// or moving a box around the canvas would read as "the live flow is stale".

// Order-independent structural compare, so re-ordering nodes/edges in the
// array (or dragging a node to a new position) doesn't falsely read as a
// change. Node position is deliberately left out for that reason.
export function normalizeGraphForCompare(graph) {
  const nodes = [...((graph && graph.nodes) || [])]
    .map((n) => ({ id: n.id, kind: n.kind, label: n.label || "", config: n.config || {} }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...((graph && graph.edges) || [])]
    .map((e) => ({ id: e.id, from: e.from, to: e.to, branch: e.branch || null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ nodes, edges });
}

export function graphsEqual(a, b) {
  return normalizeGraphForCompare(a) === normalizeGraphForCompare(b);
}

// The published graph a campaign is currently running, or null when it has
// never been published — or when the caller only has the list shape, which
// carries `liveVersion` but no `versions[]`. Those two are not the same thing
// and callers have to be able to tell them apart, which is why this returns
// null rather than an empty graph.
export function findLiveGraph(campaign) {
  const version = campaign.liveVersion;
  if (version === null || version === undefined) return null;
  const entry = (campaign.versions || []).find((v) => v.version === version);
  return entry ? { nodes: entry.nodes || [], edges: entry.edges || [] } : null;
}
