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
    biginId: { type: String, trim: true, index: true, sparse: true },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    name: { type: String, trim: true },
    phone: { type: String, trim: true, index: true },
    email: { type: String, trim: true, lowercase: true },
    company: { type: String, trim: true },
    source: { type: String, trim: true, default: "bigin" }, // "csv" | "webhook" | ...
    raw: { type: Map, of: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// Fast lookups / dedup. biginId is the primary key when we have it; otherwise
// phone is the natural key. Both are sparse-unique so blanks don't collide.
contactSchema.index({ biginId: 1 }, { unique: true, sparse: true });
contactSchema.index({ phone: 1 }, { unique: true, sparse: true });

module.exports = model("Contact", contactSchema);
