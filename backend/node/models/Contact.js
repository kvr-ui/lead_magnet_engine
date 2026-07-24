const { Schema, model } = require("mongoose");

/**
 * A contact synced from Zoho Bigin.
 *
 * Two sources feed this collection and both use the same upsert key so they
 * never create duplicates of each other:
 *   - a one-time CSV import of the existing ~thousands of contacts
 *   - a realtime Zoho Flow webhook fired whenever a contact is created/updated
 *     in Bigin (see routes/contacts.js)
 *
 * We keep the fields we care about as first-class columns and stash the whole
 * original payload/row in `raw` so nothing Bigin sends is ever lost.
 */
const contactSchema = new Schema(
  {
    // Bigin's own record id — the most reliable dedup key when present.
    biginId: { type: String, trim: true },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    company: { type: String, trim: true },
    source: { type: String, trim: true, default: "bigin" }, // "csv" | "webhook" | ...
    // CA-specific lead fields — the Zoho Flow for this pipeline sends these
    // instead of email/company, so surface them as first-class columns too.
    city: { type: String, trim: true },
    caStatus: { type: String, trim: true }, // CA_Status: Foundation/Intermediate/Final
    attempt: { type: String, trim: true },
    language: { type: String, trim: true },
    potential: { type: String, trim: true },
    status: { type: String, trim: true },
    notes: { type: String, trim: true },
    leadSource: { type: String, trim: true },
    ownerName: { type: String, trim: true },
    referralDate: { type: String, trim: true },
    raw: { type: Map, of: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// Fast lookups / dedup. biginId is the primary key when we have it; otherwise
// phone is the natural key. Both are sparse-unique so blanks don't collide.
contactSchema.index({ biginId: 1 }, { unique: true, sparse: true });
contactSchema.index({ phone: 1 }, { unique: true, sparse: true });

module.exports = model("Contact", contactSchema);
