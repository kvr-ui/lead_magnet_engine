import { describeFilter } from "./FilterBuilder";

// What a campaign is actually doing right now, today scattered across four
// places (the header's global kill switch, the campaign's own active flag,
// the publish/draft state on its canvas, and the auto-enroll notice that
// used to live only inside CampaignDetail) collapsed into one glance and one
// sentence.
//
// `campaign` is expected to carry the full detail shape (see GET
// /api/campaigns/:id): active, autoEnroll, autoEnrollFilter,
// lastAutoEnrollAt/Count/Error, liveVersion, versions[], draft. The list
// shape from GET /api/campaigns (nodeCount/versionCount only) is not enough
// to tell draft from published, which is the whole point of this component.
//
// Sending state is not fetched here — it is lifted to the app root (see
// App.jsx) and passed down, so this component and the header toggle always
// agree and there is never a second poll of it.

// Order-independent structural compare of the draft graph against a
// published version, so dragging a node around the canvas (same nodes/edges,
// different position) doesn't falsely read as "differs from live". Node
// position is deliberately left out of the comparison for that reason.
// Intentionally not imported from FlowCanvas.jsx (which has its own,
// position-inclusive version of this used to gate the Publish button) — that
// file is owned by another task in this plan.
function normalizeGraphForCompare(graph) {
  const nodes = [...((graph && graph.nodes) || [])]
    .map((n) => ({ id: n.id, kind: n.kind, label: n.label || "", config: n.config || {} }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...((graph && graph.edges) || [])]
    .map((e) => ({ id: e.id, from: e.from, to: e.to, branch: e.branch || null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ nodes, edges });
}

function graphsEqual(a, b) {
  return normalizeGraphForCompare(a) === normalizeGraphForCompare(b);
}

function findLiveGraph(campaign) {
  const version = campaign.liveVersion;
  if (version === null || version === undefined) return null;
  const entry = (campaign.versions || []).find((v) => v.version === version);
  return entry ? { nodes: entry.nodes || [], edges: entry.edges || [] } : null;
}

// The sentence is the point of this component: it has to say, in the
// vocabulary an operator uses, what is happening and what would change. The
// clause that matters most is the draft/published one — when they differ, it
// has to be unambiguous that enrolled leads keep walking the published
// version until a publish happens, which is exactly the misunderstanding
// this strip exists to prevent.
function buildSentence({ active, sendingEnabled, hasPublished, draftDiffers, liveVersion, autoEnroll, filterText }) {
  const clauses = [];

  if (!active) {
    clauses.push("this campaign is paused, so no enrolled lead is currently moving through it");
  } else if (sendingEnabled === false) {
    clauses.push("this campaign is set to active, but global sending is off, so nothing actually goes out");
  } else if (sendingEnabled === null) {
    clauses.push("this campaign is active");
  } else {
    clauses.push("this campaign is active and sending");
  }

  if (!hasPublished) {
    clauses.push("it has never been published, so nobody can enroll yet");
  } else if (draftDiffers) {
    clauses.push(
      `the draft on the canvas differs from published version ${liveVersion} — enrolled leads keep walking version ${liveVersion} until you publish`
    );
  } else {
    clauses.push(`the canvas matches the live published version (v${liveVersion})`);
  }

  if (autoEnroll) {
    clauses.push(`auto-enroll is rescanning the source for ${filterText}`);
  } else {
    clauses.push("auto-enroll is off, so only leads enrolled by hand join");
  }

  const text = clauses.join("; ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

export default function CampaignStatus({
  campaign,
  sendingEnabled = null,
  sendingQueued = 0,
  sendingBusy = false,
  onToggleSending,
}) {
  const hasPublished = campaign.liveVersion !== null && campaign.liveVersion !== undefined;
  const liveGraph = findLiveGraph(campaign);
  const draftDiffers = hasPublished && liveGraph ? !graphsEqual(campaign.draft, liveGraph) : false;

  const filterText = describeFilter(campaign.autoEnrollFilter);

  const sentence = buildSentence({
    active: campaign.active,
    sendingEnabled,
    hasPublished,
    draftDiffers,
    liveVersion: campaign.liveVersion,
    autoEnroll: campaign.autoEnroll,
    filterText,
  });

  return (
    <div className="campaign-status">
      {/* The single most valuable thing this strip surfaces: a campaign can
          say "Active" and still send nothing because the network-wide switch
          is off. Leads the strip, styled as a notice, with the fix one click
          away instead of sending the operator hunting for the header. */}
      {sendingEnabled === false && (
        <div className="notice campaign-status-sending-notice">
          <strong>Global sending is off.</strong> No campaign — including this one — is sending anything right now.{" "}
          <button type="button" className="link-btn" onClick={onToggleSending} disabled={sendingBusy}>
            {sendingBusy ? "Turning on…" : "Turn sending on"}
          </button>
          {sendingQueued > 0 && <span className="muted"> {sendingQueued} lead(s) already queued, waiting.</span>}
        </div>
      )}

      <div className="campaign-status-badges">
        {campaign.active ? (
          <span className="badge badge-success">Active</span>
        ) : (
          <span className="badge badge-neutral">Paused</span>
        )}

        {!hasPublished && <span className="badge badge-neutral">Never published</span>}
        {hasPublished && !draftDiffers && <span className="badge badge-success">Live: v{campaign.liveVersion}</span>}
        {hasPublished && draftDiffers && (
          <span className="badge badge-warning">Draft differs from v{campaign.liveVersion}</span>
        )}

        {campaign.autoEnroll && campaign.lastAutoEnrollError && (
          <span className="badge badge-warning">Auto-enroll error</span>
        )}
        {campaign.autoEnroll && !campaign.lastAutoEnrollError && (
          <span className="badge badge-info">Auto-enroll scanning</span>
        )}
        {!campaign.autoEnroll && <span className="badge badge-neutral">Auto-enroll off</span>}
      </div>

      <p className="campaign-status-sentence">{sentence}</p>

      {campaign.autoEnroll && (
        <p className="muted campaign-status-autoenroll-detail">
          Filter: {filterText} ·{" "}
          {campaign.lastAutoEnrollError
            ? `last check failed: ${campaign.lastAutoEnrollError}`
            : campaign.lastAutoEnrollAt
              ? `last checked ${new Date(campaign.lastAutoEnrollAt).toLocaleString()} — added ${campaign.lastAutoEnrollCount || 0}`
              : "not checked yet"}
        </p>
      )}
    </div>
  );
}
