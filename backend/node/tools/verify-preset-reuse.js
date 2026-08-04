// Standalone, black-box verification of the two reuse mechanisms in task 14:
// the node preset library (models/NodePreset.js, routes/nodePresets.js) and
// duplicate-flow (POST /api/campaigns/:id/duplicate in routes/campaigns.js).
//
// Same pattern as verify-graph-walk.js / verify-webhook.js: connect straight to
// the local dev Mongo, seed throwaway data under an unmistakable __verify_*__
// name, drive the real code path, assert one invariant at a time with check(),
// clean up on every path, exit non-zero on any failure.
//
// Unlike verify-graph-walk.js this drives the *routes*, not library functions —
// the invariants being checked are properties of what the HTTP endpoints write,
// so the routers are mounted on a throwaway Express app on an ephemeral port
// and driven with real requests. requireAdminAuth is deliberately not mounted:
// it is index.js's business and has nothing to do with what is being verified.
//
// Nothing here sends anything. No walker is run, no sender (real or fake) is
// ever constructed, and neither router touches the WhatsApp provider.
//
// Run:  node tools/verify-preset-reuse.js
const express = require("express");
const mongoose = require("mongoose");

const Campaign = require("../models/Campaign");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const NodePreset = require("../models/NodePreset");
const nodePresetsRouter = require("../routes/nodePresets");
const campaignsRouter = require("../routes/campaigns");

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/wati_cleanup";

const PREFIX = "__verify_preset_reuse__";
const PRESET_NAME = `${PREFIX} welcome message`;
const HOST_CAMPAIGN = `${PREFIX} host`;
const SOURCE_CAMPAIGN = `${PREFIX} source`;
const PLAIN_CAMPAIGN = `${PREFIX} plain`;

// The config the preset is saved with, and the config every node inserted from
// it must still have after the preset is edited.
const ORIGINAL_CONFIG = {
  templateId: "verify_preset_tpl",
  providerMeta: { broadcastName: "original_broadcast" },
  params: [{ index: 1, from: "name" }],
};
const EDITED_CONFIG = {
  templateId: "verify_preset_tpl_EDITED",
  providerMeta: { broadcastName: "edited_broadcast" },
  params: [{ index: 1, from: "phone" }, { index: 2, from: "name" }],
};

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Deep equality that ignores property order. Needed because a Mongoose document
// serializes its nested paths in a different order than a plain object holding
// the same values does — a difference in the JSON text that is not a difference
// in the graph.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}
const deepEqual = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// Every property name appearing anywhere inside a value, at any depth. Used to
// prove a stored campaign node carries no key that could be a back-reference to
// the preset it came from.
function allKeys(value, into = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((entry) => allKeys(entry, into));
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      allKeys(entry, into);
    }
  }
  return into;
}

// What FlowCanvas.jsx does on a preset drop, reproduced exactly: a fresh node
// id, the drop position, the preset's kind, and a DEEP COPY of its config.
// Nothing from the preset document itself — no _id, no back-reference of any
// kind — goes onto the node.
function insertPresetAsNode(preset, id, position) {
  return {
    id,
    kind: preset.kind,
    label: preset.name,
    position,
    config: JSON.parse(JSON.stringify(preset.config || {})),
  };
}

let server = null;
let baseUrl = "";

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api", campaignsRouter);
  app.use("/api", nodePresetsRouter);
  // Mirrors index.js's JSON error handler, so a rejected handler surfaces as a
  // readable failure here rather than as an HTML page fetch can't parse.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || (err.name === "CastError" || err.name === "ValidationError" ? 400 : 500);
    if (res.headersSent) return res.end();
    res.status(status).json({ error: "Request failed", detail: err.message });
  });

  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stopServer() {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = null;
}

async function api(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

let wipe = async () => {};

(async () => {
  await mongoose.connect(URI);
  await startServer();

  wipe = async () => {
    const campaigns = await Campaign.find({ name: { $regex: `^${PREFIX}` } }).select("_id").lean();
    await CampaignEnrollment.deleteMany({ campaign: { $in: campaigns.map((c) => c._id) } });
    await Campaign.deleteMany({ name: { $regex: `^${PREFIX}` } });
    await NodePreset.deleteMany({ name: { $regex: `^${PREFIX}` } });
  };
  await wipe(); // clean slate from any previous crashed run

  try {
    // === Part 1: presets are copied, not linked ==========================

    const preset = await api("POST", "/api/node-presets", {
      name: PRESET_NAME,
      kind: "message",
      // The canvas sends the node's kind and config and nothing else; these two
      // per-instance keys are sent anyway to prove the route strips them.
      config: { ...ORIGINAL_CONFIG, id: "should-not-survive", position: { x: 9, y: 9 } },
    });

    check("POST /api/node-presets saves a preset with its kind and config", preset && preset._id && preset.kind === "message", `id=${preset && preset._id}`);
    check(
      "a saved preset stores no per-instance node id or position",
      preset.config.id === undefined && preset.config.position === undefined && same(preset.config, ORIGINAL_CONFIG),
      JSON.stringify(preset.config)
    );

    const listed = await api("GET", "/api/node-presets?kind=message");
    const listedOther = await api("GET", "/api/node-presets?kind=wait");
    check(
      "GET /api/node-presets?kind= filters by node kind",
      listed.presets.some((p) => p._id === preset._id) && !listedOther.presets.some((p) => p._id === preset._id),
      `message=${listed.presets.length} wait=${listedOther.presets.length}`
    );

    // Insert it into a campaign exactly as the canvas does, then publish, so
    // the same config exists both in a draft and baked into versions[].
    const host = await api("POST", "/api/campaigns", { name: HOST_CAMPAIGN, draft: { nodes: [], edges: [] } });
    const insertedNode = insertPresetAsNode(preset, "n_from_preset", { x: 120, y: 60 });
    await api("PATCH", `/api/campaigns/${host._id}`, { draft: { nodes: [insertedNode], edges: [] } });
    await api("POST", `/api/campaigns/${host._id}/publish`);

    const beforeEdit = await api("GET", `/api/campaigns/${host._id}`);
    check(
      "a preset inserted onto the canvas lands as an ordinary node with its own id and position",
      beforeEdit.draft.nodes[0].id === "n_from_preset" &&
        beforeEdit.draft.nodes[0].position.x === 120 &&
        same(beforeEdit.draft.nodes[0].config, ORIGINAL_CONFIG),
      JSON.stringify(beforeEdit.draft.nodes[0])
    );
    check(
      "publishing bakes that node's config into versions[]",
      beforeEdit.versions.length === 1 && same(beforeEdit.versions[0].nodes[0].config, ORIGINAL_CONFIG),
      `versions=${beforeEdit.versions.length}`
    );

    // --- THE CORE INVARIANT ---------------------------------------------
    const editedPreset = await api("PATCH", `/api/node-presets/${preset._id}`, {
      name: `${PRESET_NAME} v2`,
      config: EDITED_CONFIG,
    });
    check("PATCH /api/node-presets/:id edits the preset itself", same(editedPreset.config, EDITED_CONFIG), JSON.stringify(editedPreset.config));

    const afterEdit = await api("GET", `/api/campaigns/${host._id}`);
    check(
      "editing a preset leaves an already-inserted DRAFT node's config completely unchanged",
      same(afterEdit.draft.nodes[0].config, ORIGINAL_CONFIG),
      JSON.stringify(afterEdit.draft.nodes[0].config)
    );
    check(
      "editing a preset leaves a node baked into a PUBLISHED versions[] entry completely unchanged",
      same(afterEdit.versions[0].nodes[0].config, ORIGINAL_CONFIG),
      JSON.stringify(afterEdit.versions[0].nodes[0].config)
    );

    // A campaign node must be indistinguishable in storage from a hand-authored
    // one: no preset id anywhere in it, and no key that could hold one. The
    // node's *label* is exempt — it is free text the admin sees and can rewrite,
    // and it happens to be seeded from the preset's name on insert.
    const storedHost = await Campaign.findById(host._id).lean();
    const storedNodes = [...(storedHost.draft.nodes || []), ...(storedHost.versions[0].nodes || [])];
    const withoutLabels = storedNodes.map(({ label, ...rest }) => rest);
    const keys = [...allKeys(withoutLabels)];
    check(
      "no campaign node stores the preset's id or any key that could reference it",
      !JSON.stringify(withoutLabels).includes(String(preset._id)) && !keys.some((k) => /preset/i.test(k)),
      `keys: ${keys.join(", ")}`
    );

    await api("DELETE", `/api/node-presets/${preset._id}`);
    const afterDelete = await api("GET", `/api/campaigns/${host._id}`);
    check(
      "deleting the preset entirely leaves both inserted copies intact",
      same(afterDelete.draft.nodes[0].config, ORIGINAL_CONFIG) && same(afterDelete.versions[0].nodes[0].config, ORIGINAL_CONFIG),
      JSON.stringify(afterDelete.draft.nodes[0].config)
    );

    // === Part 2: duplicate flow =========================================

    const sourceNodes = [
      { id: "n_src", kind: "source", label: "Lead", position: { x: 0, y: 0 }, config: { sourceId: "Lead", filter: {}, map: { phone: "phone" } } },
      { id: "n_msg", kind: "message", label: "Hello", position: { x: 0, y: 120 }, config: { templateId: "verify_preset_tpl", params: [] } },
      { id: "n_exit", kind: "exit", label: "Done", position: { x: 0, y: 240 }, config: { outcome: "completed" } },
    ];
    const sourceEdges = [
      { id: "e1", from: "n_src", to: "n_msg" },
      { id: "e2", from: "n_msg", to: "n_exit" },
    ];

    const source = await api("POST", "/api/campaigns", {
      name: SOURCE_CAMPAIGN,
      description: "proven nurture sequence",
      draft: { nodes: sourceNodes, edges: sourceEdges },
    });
    await api("POST", `/api/campaigns/${source._id}/publish`);

    // Arm auto-enroll and enroll a lead directly on the documents. Both are
    // seeding, not the thing under test — /enroll would need a real source to
    // scan, and PATCH deliberately refuses to arm auto-enroll at all.
    await Campaign.updateOne(
      { _id: source._id },
      { autoEnroll: true, autoEnrollFilter: { sources: [{ nodeId: "n_src", sourceId: "Lead", filter: {} }] } }
    );
    await CampaignEnrollment.create({
      campaign: source._id,
      targetModel: "Lead",
      targetId: new mongoose.Types.ObjectId(),
      phone: "919000000097",
      graphVersion: 1,
      currentNodeId: "n_msg",
      nextSendAt: new Date(),
    });

    const armedSource = await Campaign.findById(source._id).lean();
    check(
      "the campaign being duplicated is published, armed and has an enrollment",
      armedSource.versions.length === 1 && armedSource.liveVersion === 1 && armedSource.autoEnroll === true &&
        (await CampaignEnrollment.countDocuments({ campaign: source._id })) === 1,
      `versions=${armedSource.versions.length} liveVersion=${armedSource.liveVersion} autoEnroll=${armedSource.autoEnroll}`
    );

    const clone = await api("POST", `/api/campaigns/${source._id}/duplicate`);

    // Compared against the source's *stored* draft rather than against the
    // literals posted above: Mongoose minimizes empty objects away on save, so
    // the stored graph is what a faithful copy has to reproduce.
    const storedSourceDraft = (await api("GET", `/api/campaigns/${source._id}`)).draft;
    check(
      "the clone's draft.nodes/edges match the source's stored graph exactly",
      deepEqual(clone.draft.nodes, storedSourceDraft.nodes) && deepEqual(clone.draft.edges, storedSourceDraft.edges),
      `nodes=${clone.draft.nodes.length}/${storedSourceDraft.nodes.length} edges=${clone.draft.edges.length}/${storedSourceDraft.edges.length}`
    );
    check(
      "the clone carries every node the source graph declared",
      clone.draft.nodes.length === sourceNodes.length && clone.draft.edges.length === sourceEdges.length,
      `nodes=${clone.draft.nodes.length} edges=${clone.draft.edges.length}`
    );

    const cloneNodeIds = new Set(clone.draft.nodes.map((n) => n.id));
    check(
      "every edge in the clone points at nodes that exist inside the clone",
      clone.draft.edges.every((e) => cloneNodeIds.has(e.from) && cloneNodeIds.has(e.to)),
      clone.draft.edges.map((e) => `${e.from}->${e.to}`).join(", ")
    );

    check(
      "the clone is unpublished: empty versions[], no liveVersion",
      (clone.versions || []).length === 0 && (clone.liveVersion === null || clone.liveVersion === undefined),
      `versions=${(clone.versions || []).length} liveVersion=${clone.liveVersion}`
    );

    check("the clone has auto-enroll off even though the source has it on", clone.autoEnroll === false, `autoEnroll=${clone.autoEnroll}`);

    const cloneEnrollments = await CampaignEnrollment.countDocuments({ campaign: clone._id });
    check("the clone has zero enrollments", cloneEnrollments === 0, `enrollments=${cloneEnrollments}`);

    check("the clone is named identifiably as a copy", clone.name !== source.name && clone.name.includes("(copy)"), clone.name);

    // Same defaulting path as an ordinary new campaign, not a divergent one.
    const plain = await api("POST", "/api/campaigns", { name: PLAIN_CAMPAIGN });
    check(
      "the clone's non-graph defaults match a campaign created through POST /api/campaigns",
      clone.active === plain.active &&
        clone.autoEnroll === plain.autoEnroll &&
        same(clone.autoEnrollFilter, plain.autoEnrollFilter) &&
        (clone.versions || []).length === (plain.versions || []).length,
      `clone active=${clone.active} autoEnroll=${clone.autoEnroll} | plain active=${plain.active} autoEnroll=${plain.autoEnroll}`
    );

    // Deep copy, not a shared subtree: editing the clone must not reach back.
    await api("PATCH", `/api/campaigns/${clone._id}`, {
      draft: {
        nodes: clone.draft.nodes.map((n) => (n.id === "n_msg" ? { ...n, config: { templateId: "CLONE_ONLY", params: [] } } : n)),
        edges: clone.draft.edges,
      },
    });
    const sourceAfterCloneEdit = await Campaign.findById(source._id).lean();
    check(
      "editing the clone's graph leaves the source campaign's draft and published version untouched",
      sourceAfterCloneEdit.draft.nodes.find((n) => n.id === "n_msg").config.templateId === "verify_preset_tpl" &&
        sourceAfterCloneEdit.versions[0].nodes.find((n) => n.id === "n_msg").config.templateId === "verify_preset_tpl",
      sourceAfterCloneEdit.draft.nodes.find((n) => n.id === "n_msg").config.templateId
    );

    check(
      "duplicating did not disturb the source campaign's publish state, arming or enrollments",
      sourceAfterCloneEdit.versions.length === 1 &&
        sourceAfterCloneEdit.liveVersion === 1 &&
        sourceAfterCloneEdit.autoEnroll === true &&
        (await CampaignEnrollment.countDocuments({ campaign: source._id })) === 1,
      `versions=${sourceAfterCloneEdit.versions.length} autoEnroll=${sourceAfterCloneEdit.autoEnroll}`
    );
  } finally {
    await wipe();
    await stopServer();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await mongoose.disconnect();
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try {
    await wipe();
    await stopServer();
  } catch (cleanupErr) {
    console.error("cleanup also failed:", cleanupErr);
  }
  try {
    await mongoose.disconnect();
  } catch {
    /* already disconnected or never connected */
  }
  process.exit(1);
});
