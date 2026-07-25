// Ported from backend/python/wati_cleanup.py's clean_phone() — same rules,
// same default country code, so a number that's valid for the CSV export
// tool is valid here too.
const DEFAULT_COUNTRY_CODE = "91";

// Return a WATI-ready phone string ("<countryCode><10 digits>"), or null if
// the input can't be resolved to a plausible 10-digit Indian number.
function cleanPhone(raw, countryCode = DEFAULT_COUNTRY_CODE) {
  if (raw === null || raw === undefined) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;

  if (digits.length === 12 && digits.startsWith("91")) {
    digits = digits.slice(2);
  } else if (digits.length === 13 && digits.startsWith("091")) {
    digits = digits.slice(3);
  } else if (digits.length === 11 && digits.startsWith("0")) {
    digits = digits.slice(1);
  }

  if (digits.length !== 10) return null;
  return `${countryCode}${digits}`;
}

module.exports = { cleanPhone };
