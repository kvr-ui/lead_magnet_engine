const fs = require("fs");
const path = require("path");
const LeadMagnetConfig = require("../models/LeadMagnetConfig");

const SEED_PATH = path.join(__dirname, "..", "config", "leadMagnets.json");
const VALID_TYPES = new Set(["string", "number", "boolean", "date"]);

let cache = null; // Map<key, magnet> | null when not yet loaded

// Runs once at startup. If the LeadMagnetConfig collection is empty,
// import config/leadMagnets.json into it so existing setups keep working.
// After this, the JSON file is no longer read — Mongo is the source of truth.
async function seedFromFileIfEmpty() {
  const count = await LeadMagnetConfig.countDocuments();
  if (count > 0) return;
  if (!fs.existsSync(SEED_PATH)) return;

  const parsed = JSON.parse(fs.readFileSync(SEED_PATH, "utf8"));
  const list = Array.isArray(parsed.leadMagnets) ? parsed.leadMagnets : [];
  if (!list.length) return;

  await LeadMagnetConfig.insertMany(
    list.map((m) => ({
      key: m.key,
      label: m.label || m.key,
      fields: (m.fields || []).map((f) => ({
        name: f.name,
        type: f.type || "string",
        required: !!f.required,
      })),
    })),
    { ordered: false }
  );
}

async function refreshCache() {
  const docs = await LeadMagnetConfig.find().sort({ createdAt: 1 }).lean();
  cache = new Map(
    docs.map((d) => [
      d.key,
      { key: d.key, label: d.label, fields: d.fields.map((f) => ({ ...f })) },
    ])
  );
  return cache;
}

function getLeadMagnets() {
  if (!cache) throw new Error("Lead magnet cache not initialized — call initLeadMagnets() at startup");
  return cache;
}

function getLeadMagnet(key) {
  return getLeadMagnets().get(key);
}

function listLeadMagnets() {
  return Array.from(getLeadMagnets().values());
}

function validateFieldDef(field) {
  if (!field.name || typeof field.name !== "string") {
    throw badRequest('Field "name" is required');
  }
  if (field.type && !VALID_TYPES.has(field.type)) {
    throw badRequest(`Unknown field type "${field.type}"`);
  }
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

async function createLeadMagnet({ key, label, fields = [] }) {
  if (!key || typeof key !== "string") throw badRequest('"key" is required');
  fields.forEach(validateFieldDef);
  const existing = await LeadMagnetConfig.findOne({ key });
  if (existing) throw badRequest(`Lead magnet "${key}" already exists`);

  await LeadMagnetConfig.create({ key, label: label || key, fields });
  await refreshCache();
}

async function updateLeadMagnetLabel(key, label) {
  const doc = await LeadMagnetConfig.findOneAndUpdate({ key }, { $set: { label } }, { new: true });
  if (!doc) throw notFound(key);
  await refreshCache();
}

async function addField(key, field) {
  validateFieldDef(field);
  const doc = await LeadMagnetConfig.findOne({ key });
  if (!doc) throw notFound(key);
  if (doc.fields.some((f) => f.name === field.name)) {
    throw badRequest(`Field "${field.name}" already exists on "${key}"`);
  }
  doc.fields.push(field);
  await doc.save();
  await refreshCache();
}

async function removeField(key, fieldName) {
  const doc = await LeadMagnetConfig.findOne({ key });
  if (!doc) throw notFound(key);
  doc.fields = doc.fields.filter((f) => f.name !== fieldName);
  await doc.save();
  await refreshCache();
}

async function deleteLeadMagnet(key) {
  const res = await LeadMagnetConfig.deleteOne({ key });
  if (res.deletedCount === 0) throw notFound(key);
  await refreshCache();
}

function notFound(key) {
  const err = new Error(`Lead magnet "${key}" not found`);
  err.status = 404;
  return err;
}

function coerce(value, type) {
  switch (type) {
    case "number": {
      const n = Number(value);
      return Number.isNaN(n) ? undefined : n;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      return value === "true" || value === "1" || value === true;
    case "date": {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? undefined : d;
    }
    default:
      return value === undefined || value === null ? value : String(value);
  }
}

/**
 * Validate + coerce a raw payload's extra fields against a lead magnet's
 * field definitions. Throws a ValidationError (with .details) on failure.
 */
function validateExtraFields(magnet, rawExtra = {}) {
  const errors = [];
  const clean = {};

  for (const field of magnet.fields) {
    const raw = rawExtra[field.name];
    const missing = raw === undefined || raw === null || raw === "";
    if (missing) {
      if (field.required) errors.push(`"${field.name}" is required`);
      continue;
    }
    const coerced = coerce(raw, field.type);
    if (coerced === undefined) {
      errors.push(`"${field.name}" must be a valid ${field.type}`);
      continue;
    }
    clean[field.name] = coerced;
  }

  if (errors.length) {
    const err = new Error(`Invalid fields for lead magnet "${magnet.key}": ${errors.join(", ")}`);
    err.status = 400;
    err.details = errors;
    throw err;
  }

  return clean;
}

async function initLeadMagnets() {
  await seedFromFileIfEmpty();
  await refreshCache();
}

module.exports = {
  initLeadMagnets,
  getLeadMagnets,
  getLeadMagnet,
  listLeadMagnets,
  createLeadMagnet,
  updateLeadMagnetLabel,
  addField,
  removeField,
  deleteLeadMagnet,
  validateExtraFields,
};
