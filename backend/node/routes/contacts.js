const express = require("express");
const Contact = require("../models/Contact");

const router = express.Router();

// Optional shared secret. Set CONTACTS_WEBHOOK_SECRET in .env and have Zoho
// Flow send it as ?secret=... or an "x-webhook-secret" header. If unset, the
// webhook is open (fine behind a trusted network / obscure URL, but set it).
const WEBHOOK_SECRET = process.env.CONTACTS_WEBHOOK_SECRET || "";

// ---------------------------------------------------------------------------
// Field normalization
// ---------------------------------------------------------------------------
// Bigin / Zoho Flow can label fields many ways depending on how the flow is
// mapped. We look for the common variants (case-insensitive) and fall back to
// keeping everything in `raw`. Adjust these lists to match your flow if needed.
const FIELD_ALIASES = {
  biginId: ["id", "biginid", "bigin_id", "record_id", "recordid", "contact_id"],
  firstName: ["first_name", "firstname", "first name"],
  lastName: ["last_name", "lastname", "last name"],
  name: ["name", "full_name", "fullname", "contact_name", "full name"],
  phone: ["phone", "mobile", "phone_number", "mobile_number", "whatsapp", "contact_number"],
  email: ["email", "email_address", "e-mail", "emailid", "email_id"],
  company: ["company", "account_name", "organization", "account name"],
  city: ["city", "other_city", "location"],
  caStatus: ["ca_status", "castatus", "level"],
  attempt: ["attempt"],
  language: ["language"],
  potential: ["potential"],
  status: ["status"],
  notes: ["notess", "notes", "note"],
  leadSource: ["lead_source1", "lead_source", "leadsource"],
  referralDate: ["referral_date", "referraldate"],
};

function pick(lowerKeyed, aliases) {
  for (const a of aliases) {
    const v = lowerKeyed[a];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return undefined;
}

// Owner is a nested { name, id, email } object rather than a flat field, so
// it needs its own extraction instead of a simple alias lookup.
function pickOwnerName(record) {
  const owner = record?.Owner ?? record?.owner;
  if (owner && typeof owner === "object" && owner.name) return String(owner.name).trim();
  if (typeof owner === "string" && owner.trim()) return owner.trim();
  return undefined;
}

// Turn an arbitrary object (webhook body or CSV row) into a Contact-shaped doc.
function normalize(record, source) {
  // Lower-case keys so alias matching is case-insensitive.
  const lower = {};
  for (const [k, v] of Object.entries(record || {})) {
    lower[String(k).trim().toLowerCase()] = v;
  }

  const doc = {
    biginId: pick(lower, FIELD_ALIASES.biginId),
    firstName: pick(lower, FIELD_ALIASES.firstName),
    lastName: pick(lower, FIELD_ALIASES.lastName),
    name: pick(lower, FIELD_ALIASES.name),
    phone: pick(lower, FIELD_ALIASES.phone),
    email: pick(lower, FIELD_ALIASES.email),
    company: pick(lower, FIELD_ALIASES.company),
    city: pick(lower, FIELD_ALIASES.city),
    caStatus: pick(lower, FIELD_ALIASES.caStatus),
    attempt: pick(lower, FIELD_ALIASES.attempt),
    language: pick(lower, FIELD_ALIASES.language),
    potential: pick(lower, FIELD_ALIASES.potential),
    status: pick(lower, FIELD_ALIASES.status),
    notes: pick(lower, FIELD_ALIASES.notes),
    leadSource: pick(lower, FIELD_ALIASES.leadSource),
    referralDate: pick(lower, FIELD_ALIASES.referralDate),
    ownerName: pickOwnerName(record),
    source,
    raw: record || {},
  };

  // Derive a display name if only first/last were provided.
  if (!doc.name && (doc.firstName || doc.lastName)) {
    doc.name = [doc.firstName, doc.lastName].filter(Boolean).join(" ");
  }
  return doc;
}

// Choose the upsert filter: prefer Bigin's id, else phone. If we have neither
// there's nothing to dedup on, so the caller falls back to a plain insert —
// every record gets stored, we just can't dedup ones with no id/phone.
function upsertFilter(doc) {
  if (doc.biginId) return { biginId: doc.biginId };
  if (doc.phone) return { phone: doc.phone };
  return null;
}

function fieldSet(doc) {
  // Don't overwrite existing values with blanks — only set fields we actually got.
  const set = {};
  for (const key of [
    "biginId", "firstName", "lastName", "name", "phone", "email", "company", "source",
    "city", "caStatus", "attempt", "language", "potential", "status", "notes",
    "leadSource", "referralDate", "ownerName",
  ]) {
    if (doc[key] !== undefined && doc[key] !== "") set[key] = doc[key];
  }
  set.raw = doc.raw;
  return set;
}

// Build a single bulkWrite op for this record. Upserts when we have a
// biginId/phone to dedup on; otherwise inserts it as a new document so no
// data is ever dropped (e.g. incomplete test payloads from Zoho Flow).
function toBulkOp(doc) {
  const filter = upsertFilter(doc);
  const set = fieldSet(doc);
  if (filter) {
    return { updateOne: { filter, update: { $set: set }, upsert: true } };
  }
  return { insertOne: { document: set } };
}

// ---------------------------------------------------------------------------
// Minimal CSV parser (handles quoted fields, commas/newlines in quotes, "" escapes).
// Avoids pulling in a dependency for a one-time import.
// ---------------------------------------------------------------------------
function parseCSV(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  // flush last field/row
  if (field !== "" || row.length) { row.push(field); rows.push(row); }

  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((v) => v && v.trim() !== ""))
    .map((r) => {
      const obj = {};
      headers.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ""; });
      return obj;
    });
}

async function bulkUpsert(docs) {
  const ops = docs.map(toBulkOp);
  if (!ops.length) return { matched: 0, upserted: 0, modified: 0, inserted: 0 };

  let upserted = 0, modified = 0, matched = 0, inserted = 0;
  // Chunk so a huge CSV doesn't blow past MongoDB's bulk limits.
  const CHUNK = 1000;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const res = await Contact.bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
    upserted += res.upsertedCount || 0;
    modified += res.modifiedCount || 0;
    matched += res.matchedCount || 0;
    inserted += res.insertedCount || 0;
  }
  return { matched, upserted, modified, inserted };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// POST /api/contacts/webhook — realtime, one contact per call from Zoho Flow.
// Also accepts an array of contacts, in case a flow batches them.
router.post("/contacts/webhook", async (req, res) => {
  console.log(`[contacts/webhook] ${new Date().toISOString()} body:`, JSON.stringify(req.body));

  if (WEBHOOK_SECRET) {
    const provided = req.get("x-webhook-secret") || req.query.secret;
    if (provided !== WEBHOOK_SECRET) {
      console.log("[contacts/webhook] rejected: invalid or missing secret");
      return res.status(401).json({ error: "Invalid or missing webhook secret" });
    }
  }

  const body = req.body;
  const records = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [body];
  const docs = records.map((r) => normalize(r, "webhook"));

  try {
    const result = await bulkUpsert(docs);
    console.log("[contacts/webhook] result:", result);
    res.status(201).json({ ok: true, received: records.length, ...result });
  } catch (err) {
    console.error("[contacts/webhook] error:", err.message);
    res.status(500).json({ error: "Failed to save contact(s)", detail: err.message });
  }
});

// POST /api/contacts/import — one-time bulk import of the existing contacts.
// Send the CSV as the raw request body with Content-Type: text/csv, e.g.
//   curl -X POST http://HOST/api/contacts/import \
//        -H "Content-Type: text/csv" --data-binary @contacts.csv
// Or POST JSON { "contacts": [ {...}, {...} ] } with Content-Type: application/json.
router.post("/contacts/import", async (req, res) => {
  let records;
  if (typeof req.body === "string") {
    records = parseCSV(req.body);
  } else if (Array.isArray(req.body?.contacts)) {
    records = req.body.contacts;
  } else if (Array.isArray(req.body)) {
    records = req.body;
  } else {
    return res.status(400).json({
      error: "Send CSV as text/csv body, or JSON { contacts: [...] }",
    });
  }

  if (!records.length) return res.status(400).json({ error: "No rows found in payload" });

  const docs = records.map((r) => normalize(r, "csv"));
  try {
    const result = await bulkUpsert(docs);
    res.status(201).json({ ok: true, rows: records.length, ...result });
  } catch (err) {
    res.status(500).json({ error: "Import failed", detail: err.message });
  }
});

// GET /api/contacts?page=1&limit=50 — paginated list + total count.
router.get("/contacts", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const [contacts, total] = await Promise.all([
    Contact.find()
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Contact.estimatedDocumentCount(),
  ]);
  res.json({
    total,
    count: contacts.length,
    page,
    pageSize: limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    contacts,
  });
});

module.exports = router;
