const NodePreset = require("../models/NodePreset");
const Campaign = require("../models/Campaign");
const { asyncRouter } = require("../lib/asyncRouter");

const router = asyncRouter();

/**
 * CRUD for the node preset library (models/NodePreset.js). Mounted behind
 * requireAdminAuth in index.js, same as every other route that reads or writes
 * campaign configuration.
 *
 * Note what is NOT here, and never may be: an endpoint that reaches into a
 * campaign to update nodes "inserted from" a preset. Presets are copied at
 * insertion time and nothing links a campaign node back to the preset it came
 * from — see the header comment on models/NodePreset.js for why the alternative
 * (live-linked shared nodes) was rejected. Editing a preset below changes what
 * the next insertion produces and nothing else, in any campaign, draft or
 * published.
 */

// A preset's config is stored exactly as posted — it is a snapshot of a node's
// config, whose per-kind shape belongs to the walker, not to this route. What
// is refused is anything that is not an object at all, and the two per-instance
// keys a node carries on a canvas: `id` and `position` mean nothing off the
// graph they were placed on, and a preset that carried them would insert a node
// that collides with, or teleports on top of, whatever else is already there.
function normalizeConfig(config) {
  if (config === undefined || config === null) return {};
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new Error("config must be an object — a snapshot of a node's config");
  }
  const { id, position, ...rest } = config;
  return rest;
}

// GET /api/node-presets?kind=message — the preset library, newest first.
// `kind` narrows it to one node kind, which is how the canvas panel renders
// one group at a time; omitted, everything comes back and the panel groups it.
router.get("/node-presets", async (req, res) => {
  const filter = {};
  const kind = (req.query.kind || "").trim();
  if (kind) {
    if (!Campaign.NODE_KINDS.includes(kind)) {
      return res.status(400).json({ error: `Unknown node kind "${kind}"` });
    }
    filter.kind = kind;
  }
  const presets = await NodePreset.find(filter).sort({ kind: 1, name: 1 }).lean();
  res.json({ presets });
});

// POST /api/node-presets { name, kind, config } — save a node's configuration
// for reuse. Called by the canvas's "Save as preset" action, which sends the
// selected node's kind and config and deliberately nothing else.
router.post("/node-presets", async (req, res) => {
  try {
    const { name, kind, config } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "A preset name is required" });
    }
    const preset = await NodePreset.create({
      name: String(name).trim(),
      kind,
      config: normalizeConfig(config),
    });
    res.status(201).json(preset);
  } catch (err) {
    res.status(400).json({ error: "Failed to save preset", detail: err.message });
  }
});

// PATCH /api/node-presets/:id { name?, config? } — edit a saved preset.
// PATCH rather than PUT to match the other CRUD routes in this codebase
// (routes/dataSources.js, routes/campaigns.js).
//
// `kind` is not editable: a preset's config shape is the shape its kind's
// handler reads, so re-kinding one in place would leave a message node's config
// sitting under a `wait` label, ready to be dropped onto a canvas as a node the
// walker cannot make sense of. Delete it and save a new one instead.
//
// This edit reaches no campaign. Every node already inserted from this preset
// keeps the config it was inserted with, in every draft and every published
// version — that is the whole point of copying on insert.
router.patch("/node-presets/:id", async (req, res) => {
  try {
    const body = req.body || {};
    if (body.kind !== undefined) {
      return res.status(400).json({ error: "A preset's kind can't be changed — save a new preset instead" });
    }
    const preset = await NodePreset.findById(req.params.id);
    if (!preset) return res.status(404).json({ error: "Preset not found" });

    if (body.name !== undefined) {
      if (!String(body.name).trim()) return res.status(400).json({ error: "A preset name is required" });
      preset.name = String(body.name).trim();
    }
    if (body.config !== undefined) {
      preset.config = normalizeConfig(body.config);
      // Mixed paths are not change-tracked by Mongoose when mutated in place;
      // this assignment replaces the value outright, but marking it is what
      // keeps that true if the line above is ever changed to a merge.
      preset.markModified("config");
    }

    await preset.save();
    res.json(preset);
  } catch (err) {
    res.status(400).json({ error: "Failed to update preset", detail: err.message });
  }
});

// DELETE /api/node-presets/:id — remove a preset from the library.
//
// Nothing else is touched, and nothing else needs to be: every node ever
// inserted from this preset owns its own copy of the config, so deleting the
// preset cannot leave a campaign holding a dangling reference. There is no
// reference to dangle.
router.delete("/node-presets/:id", async (req, res) => {
  const preset = await NodePreset.findByIdAndDelete(req.params.id);
  if (!preset) return res.status(404).json({ error: "Preset not found" });
  res.json({ deleted: true, name: preset.name });
});

module.exports = router;
