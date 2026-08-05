import { useEffect, useMemo, useState } from "react";
import { fetchFilterFields } from "./api";

// Lifted out of CampaignsTab.jsx unchanged when the segment builder's single
// members table was replaced by one table per source node
// (AudienceSendPanel.jsx). Two files needed the same hook, and importing it
// back out of CampaignsTab would have made the two modules import each other.

export function humanizeKey(key) {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Preview/segment table columns for *any* source, built from what the backend
 * reports about that source rather than from a per-source list written here.
 *
 * Two inputs, in this order:
 *
 *   1. The canonical keys the campaign's source node maps (`phone`, `name`,
 *      whatever else it declared). These come first because they are the keys
 *      every downstream node addresses a lead by, so they are the ones an
 *      admin is actually reasoning about. Each reads the raw field the map
 *      points at, so the column header says "Phone" while the value comes off
 *      whatever the source calls it (`phoneNumber`, `mobile`, …).
 *   2. Every remaining field the source actually has, per
 *      /api/campaigns/meta/fields, minus the ones already shown as a canonical
 *      key so a column never appears twice under two names.
 *
 * There is no per-source special case and no hardcoded column list anywhere in
 * this file. Connecting a new lead-magnet database renders its columns with no
 * code change, which is the failure this design exists to fix: previously a
 * source with no hand-written entry rendered zero columns.
 */
export function useSourceColumns(source, canonicalMap) {
  const [fields, setFields] = useState(null);

  useEffect(() => {
    if (!source) {
      setFields(null);
      return undefined;
    }
    let cancelled = false;
    setFields(null);
    fetchFilterFields(source)
      .then((d) => !cancelled && setFields(d.fields || []))
      // A source whose fields can't be read (disconnected, bad credentials)
      // still has to render its canonical columns rather than an empty table.
      .catch(() => !cancelled && setFields([]));
    return () => {
      cancelled = true;
    };
  }, [source]);

  // Keyed on the map's content, not its identity — it is rebuilt from the
  // campaign payload on every render and would otherwise recompute forever.
  const mapKey = JSON.stringify(canonicalMap || {});

  return useMemo(() => {
    if (!fields) return [];
    const canonical = Object.entries(JSON.parse(mapKey)).filter(([, field]) => field);
    const mapped = new Set(canonical.map(([, field]) => field));
    return [
      ...canonical.map(([key, field]) => ({
        key: `canonical:${key}`,
        header: humanizeKey(key),
        get: (doc) => doc[field],
      })),
      ...fields
        .filter((f) => !mapped.has(f.key))
        .map((f) => ({ key: f.key, header: f.label || f.key, get: (doc) => doc[f.key] })),
    ];
  }, [fields, mapKey]);
}
