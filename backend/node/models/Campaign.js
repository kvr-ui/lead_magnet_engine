const { Schema, model } = require("mongoose");

/**
 * A drip campaign, modelled as a *versioned graph* of typed nodes and edges
 * rather than the flat `steps: [{ templateId }]` array it used to be.
 *
 * The flat array could only ever express "send these templates in this order":
 * no delay between sends, no branch on what the lead did, no second source
 * feeding the same drip, no per-recipient template variable. A graph expresses
 * all four, at the cost of needing a stable contract that the walker, the
 * migration script, the API routes and the canvas editor can all agree on.
 * That contract is this file.
 *
 * Three top-level graph fields:
 *
 *   draft       - the in-progress graph an admin is editing on the canvas.
 *                 Nothing walks the draft; it is scratch space.
 *   versions[]  - append-only list of published snapshots. Publishing copies
 *                 draft.nodes/draft.edges into a new entry and points
 *                 liveVersion at it. Entries are immutable once written: a
 *                 later publish appends, it never edits or removes.
 *   liveVersion - the version number new enrollments are pinned to. Null/unset
 *                 until the first publish, which is why enrolling against a
 *                 never-published campaign has to be an error rather than a
 *                 silent fall back to draft.
 *
 * Every CampaignEnrollment records the liveVersion in effect when it was
 * created (`graphVersion`) and walks *that* snapshot for its whole life. This
 * is the whole point of versioning: an admin can rearrange the draft, or even
 * publish a new version, without stranding a lead half way through a drip or
 * silently re-routing it into a flow it never entered.
 */

// The nine node kinds. `kind` is a real enum so an unknown kind is rejected at
// save time rather than surfacing as an unhandled branch inside the walker.
const NODE_KINDS = ["source", "filter", "message", "wait", "condition", "split", "goal", "action", "exit"];

/**
 * One node of a graph. Deliberately a single discriminated schema - `kind`
 * plus a Mixed `config` - rather than nine polymorphic subdocument types, so
 * one `nodes` array can freely mix kinds and adding a kind doesn't reshape the
 * collection. The cost is that `config` is unvalidated by Mongoose; the shape
 * per kind is documented here and is the contract every consumer reads.
 *
 *   id       - unique within its own graph (the draft, or a single versions[]
 *              entry). Enrollments point at nodes by this id, so it must stay
 *              stable across publishes for an in-flight lead to keep walking.
 *   kind     - one of NODE_KINDS.
 *   label    - free-text admin-facing display name; never interpreted.
 *   position - canvas coordinates, editor-only, no runtime meaning.
 *   config   - per-kind, as follows:
 *
 * `source` - { sourceId, filter, map: { phone, name, email, ... } }
 *   sourceId identifies the source feeding this branch of the graph: a built-in
 *   built-in "Contact" / "Lead", or a connected Data Source as
 *   "datasource:<id>". filter is the same Mongo-ish filter shape already used
 *   by autoEnrollFilter and matchTargets (plain equality, { $in: [...] }, or a
 *   single bounded numeric comparison - see isSafeValue in lib/sourceData.js).
 *   map is the canonical field map: it translates the source's raw field names
 *   into stable canonical keys (phone, name, email, ...) so every downstream
 *   node addresses a lead by canonical key instead of per-source field wiring -
 *   which is what lets one message node serve differently-shaped sources.
 *   map.phone is required; every other key is optional and source-specific.
 *   A graph may hold more than one source node (two lead magnets feeding one
 *   drip); enrollments still carry their own targetModel per row, so that costs
 *   no enrollment schema change.
 *
 * `filter` - { filter }
 *   Same Mongo-ish filter shape as a source node's filter, applied mid-graph to
 *   narrow which leads continue past this point.
 *
 * `message` - { type, templateId, providerMeta, params: [{ index, from }], text }
 *   type is "template" (the default, and the shape every graph published before
 *   free text existed carries implicitly) or "text".
 *
 *   A "template" message references a provider-approved template by id, because
 *   that is the only thing that may be sent outside the customer-initiated 24h
 *   window. providerMeta carries whatever extra field the connected provider
 *   needs (e.g. WATI's required broadcast_name). params fills the template's
 *   variable slots: each entry's `index` is the variable position in the
 *   template and `from` names a canonical key (as produced by the enclosing
 *   source node's map) whose value is read off the lead at send time.
 *
 *   A "text" message carries its body in `text`, with {{canonicalKey}}
 *   placeholders filled from the lead at send time. It is legal ONLY inside the
 *   24h window, so it can be refused at the moment of sending however the graph
 *   was drawn - lib/whatsappProvider.js checks and the walker parks the lead.
 *   Putting a `condition` node with on: "window" in front of one is how a flow
 *   routes closed-window leads to a template instead of parking them.
 *
 * `wait` - { amount, unit, window: { from, to, tz }, skipDays: [Number] }
 *   unit is one of "minutes", "hours", "days". window optionally clamps
 *   delivery into a time-of-day range (from/to) in timezone tz; skipDays
 *   optionally lists weekday numbers to skip entirely (0 = Sunday).
 *
 * `condition` - { on, ...per-kind args }
 *   on is one of "field", "engagement", "activity", "elapsed", "window",
 *   "reply"; the remaining keys depend on which (a "field" condition needs a
 *   field/operator/value, an "elapsed" condition needs a duration, and so on).
 *   "window" takes no args at all - it asks whether the lead's phone has an
 *   open 24h conversation window, which has exactly one answer and no knobs.
 *   "reply" - { since: "lastSend" | "start" } - asks whether the lead's phone
 *   sent ANY inbound message since our last send (or since enrollment). It is
 *   phone-based, unlike "engagement" with status "replied", which asks about
 *   one specific message node's send and depends on provider message ids
 *   being backfilled.
 *   Left as Mixed on purpose
 *   - enumerating every per-kind arg set as its own sub-schema would freeze
 *   shapes the walker still owns.
 *
 * `split` - { ratio }
 *   Splits traffic between its "a" and "b" branches by ratio. The branch taken
 *   for a given lead MUST be derived from a stable hash of the enrollment's
 *   targetId, never from a random draw, so re-evaluating the same lead always
 *   re-derives the same branch instead of quietly reshuffling a live A/B test.
 *   The hashing itself lives in the walker; this note is the requirement.
 *
 * `goal` - activity-threshold config (Mixed)
 *   Evaluated by the walker to pick its "yes" / "no" branch.
 *
 * `action` - { url, method, body } for an outbound HTTP call, or a
 *   source-field write-back shape.
 *   This is the ONLY node kind that writes - it calls an external endpoint or
 *   mutates source data, as opposed to reading, branching or sending. Any
 *   implementation of it MUST be gated by the existing global send kill switch
 *   (isSendingEnabled in lib/sendingSwitch.js) and MUST default to disabled,
 *   for the same reason sending does: a fresh install, a wiped database or a
 *   failed read must never be the reason a real external side effect fires.
 *   This model captures the config shape only; the gating requirement is
 *   recorded here so it cannot be lost by whoever implements the handler.
 *
 * `exit` - { outcome }
 *   Terminates the walk for a lead with a labelled outcome.
 */
const nodeSchema = new Schema(
  {
    id: { type: String, required: true, trim: true },
    kind: { type: String, required: true, enum: NODE_KINDS },
    label: { type: String, trim: true, default: "" },
    position: {
      x: { type: Number, default: 0 },
      y: { type: Number, default: 0 },
    },
    config: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false, id: false }
);

/**
 * A directed edge between two nodes of the same graph.
 *
 * `branch` disambiguates which outgoing edge to follow when a node has more
 * than one:
 *   "yes" / "no" - edges leaving a `condition` or a `goal` node;
 *   "a" / "b"    - edges leaving a `split` node;
 *   absent       - every other kind, which has at most one outgoing edge.
 * Left a free string rather than an enum: which branch labels a kind emits is
 * the walker's contract, not the storage layer's.
 */
const edgeSchema = new Schema(
  {
    id: { type: String, required: true, trim: true },
    from: { type: String, required: true, trim: true },
    to: { type: String, required: true, trim: true },
    branch: { type: String, trim: true },
  },
  { _id: false, id: false }
);

// The editable graph. Identical node/edge shape to a published version.
const graphSchema = new Schema(
  {
    nodes: { type: [nodeSchema], default: [] },
    edges: { type: [edgeSchema], default: [] },
  },
  { _id: false, id: false }
);

// One published, immutable snapshot. `version` is what an enrollment's
// graphVersion pins to; the next publish is (highest version so far) + 1.
const graphVersionSchema = new Schema(
  {
    version: { type: Number, required: true, min: 1 },
    nodes: { type: [nodeSchema], default: [] },
    edges: { type: [edgeSchema], default: [] },
    publishedAt: { type: Date, default: Date.now },
  },
  { _id: false, id: false }
);

/**
 * Structural checks that must hold for any graph - the draft and every
 * published version alike. A published version is not exempt: the one-time
 * steps[] migration writes straight into versions[0], and a dangling edge or a
 * duplicated id there would be just as broken at walk time as it is in a draft.
 *
 * Kind validity is not checked here - `kind` is a real Mongoose enum on
 * nodeSchema, so an unknown kind is already rejected per node.
 */
function graphIntegrityErrors(graph) {
  const errors = [];
  const nodes = (graph && graph.nodes) || [];
  const edges = (graph && graph.edges) || [];

  const ids = new Set();
  const duplicates = new Set();
  for (const node of nodes) {
    const id = node && node.id;
    if (!id) continue; // absence is the `required` validator's business
    if (ids.has(id)) duplicates.add(id);
    ids.add(id);
  }
  if (duplicates.size) {
    errors.push(`duplicate node id(s): ${[...duplicates].join(", ")}`);
  }

  for (const edge of edges) {
    const label = (edge && edge.id) || "(unnamed)";
    if (edge && edge.from && !ids.has(edge.from)) {
      errors.push(`edge "${label}" starts at unknown node "${edge.from}"`);
    }
    if (edge && edge.to && !ids.has(edge.to)) {
      errors.push(`edge "${label}" points at unknown node "${edge.to}"`);
    }
  }

  return errors;
}

const campaignSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    description: { type: String, trim: true },
    // Channel identifier from the connected provider (see
    // whatsappProvider.getChannels()) - "" sends from the provider's
    // default channel.
    channelId: { type: String, default: "", trim: true },
    // The graph being edited. Never walked by an enrollment.
    draft: { type: graphSchema, default: () => ({ nodes: [], edges: [] }) },
    // Append-only publish history. Nothing may edit or remove an existing entry.
    versions: { type: [graphVersionSchema], default: [] },
    // Which versions[].version new enrollments pin to. Null until first publish.
    liveVersion: { type: Number, default: null },
    active: { type: Boolean, default: true },
    // End a lead's drip the moment they send any inbound message: their
    // enrollment is completed with outcome "replied" (see lib/replyFlows.js,
    // driven from the WATI webhook). A campaign-level flag rather than a graph
    // node so it applies instantly to every enrollment regardless of which
    // pinned graphVersion it walks, and so it is enforced from the webhook
    // like STOP handling — not something a graph shape can forget to wire in.
    stopOnReply: { type: Boolean, default: false },
    // Re-run this campaign's segment on a schedule, so targets that appear in
    // the source *after* the manual "Send campaign" click still enter the drip.
    //
    // Without this, enrollment is a one-time snapshot: enrollTargets matches
    // whoever fits the filter at that instant, writes their enrollments, and
    // nothing ever rescans the source. A lead added to a connected Data Source
    // an hour later is invisible to the campaign until someone clicks Send again.
    //
    // autoEnrollFilter is only ever written from a segment the admin previewed
    // and confirmed, never a filter posted straight at the API - an empty
    // filter here means "everyone in the source", which is not something to
    // arrive at by accident.
    autoEnroll: { type: Boolean, default: false },
    autoEnrollFilter: { type: Schema.Types.Mixed, default: {} },
    // Outcome of the last auto-enroll tick, so an armed campaign that has
    // quietly stopped picking anyone up (source credentials rotated, phone
    // field renamed) shows why in the UI instead of just looking idle.
    lastAutoEnrollAt: { type: Date },
    lastAutoEnrollCount: { type: Number },
    lastAutoEnrollError: { type: String },
  },
  { timestamps: true }
);

// Applied identically to the draft and to every published version, because a
// version is written directly by the migration script and by publish, not only
// by copying an already-validated draft.
campaignSchema.path("draft").validate({
  validator: (graph) => graphIntegrityErrors(graph).length === 0,
  message: (props) => `draft graph is invalid: ${graphIntegrityErrors(props.value).join("; ")}`,
});

campaignSchema.path("versions").validate({
  validator: (versions) => (versions || []).every((entry) => graphIntegrityErrors(entry).length === 0),
  message: (props) => {
    const problems = (props.value || [])
      .map((entry) => {
        const errors = graphIntegrityErrors(entry);
        return errors.length ? `version ${entry && entry.version}: ${errors.join("; ")}` : null;
      })
      .filter(Boolean);
    return `published graph is invalid: ${problems.join(" | ")}`;
  },
});

const Campaign = model("Campaign", campaignSchema);

// Exported alongside the model so consumers that need to enumerate or validate
// kinds (API request validation, the canvas editor's node palette) read the
// list from here instead of re-deriving it.
Campaign.NODE_KINDS = NODE_KINDS;

module.exports = Campaign;
