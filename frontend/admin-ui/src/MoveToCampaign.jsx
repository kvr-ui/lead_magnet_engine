import { useEffect, useState } from "react";
import { fetchCampaigns, previewCampaignSend, enrollCampaign } from "./api";

// Enrolls exactly the leads the current filters match into a campaign, so a
// segment built while browsing a lead magnet's data doesn't have to be
// rebuilt condition-by-condition inside the campaign's own segment builder.
//
// Only campaigns targeting this same source are offered: a filter is written
// against one source's field names, and the backend rejects it against any
// other.
export default function MoveToCampaign({ source, filter, filterKey, matchCount, onOpenCampaigns }) {
  const [open, setOpen] = useState(false);
  const [campaigns, setCampaigns] = useState(null);
  const [campaignId, setCampaignId] = useState("");
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    setLoadError(null);
    fetchCampaigns()
      .then((all) => {
        const forSource = all.filter((c) => c.targetModel === source);
        setCampaigns(forSource);
        setCampaignId((current) =>
          forSource.some((c) => c._id === current) ? current : forSource[0]?._id || ""
        );
      })
      .catch((err) => setLoadError(err.message));
  }, [open, source]);

  // A result names a lead count that only held for the filters in force when
  // it was produced — drop it the moment those change so it can't be misread
  // as describing the current selection.
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [filterKey, source]);

  const selected = (campaigns || []).find((c) => c._id === campaignId);
  const hasFilters = Object.keys(filter).length > 0;

  async function handleMove() {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const preview = await previewCampaignSend(campaignId, filter);
      const confirmed = window.confirm(
        `Move ${preview.willEnroll} lead(s) into "${selected.name}"?\n\n` +
          `${preview.matched} matched · ${preview.alreadyEnrolled} already in this campaign · ` +
          `${preview.skippedNoPhone + preview.skippedBadPhone} skipped (no/invalid phone).`
      );
      if (!confirmed) return;
      const moved = await enrollCampaign(campaignId, filter);
      setResult({ ...moved, campaignId, campaignName: selected.name });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="move-to-campaign">
      <button type="button" className="secondary-btn" onClick={() => setOpen(!open)}>
        {open ? "Cancel" : "Move to campaign →"}
      </button>

      {open && (
        <div className="enrich-editor">
          <p className="muted">
            Enrolls the {matchCount} lead{matchCount === 1 ? "" : "s"} matching the filters above into a campaign —
            they start receiving it on the next send cycle. Leads already enrolled are skipped, and ones without a
            usable phone number are left out.
          </p>
          {!hasFilters && (
            <p className="notice">No filters applied — this moves every lead in this source.</p>
          )}

          {loadError && <p className="error">{loadError}</p>}
          {!campaigns && !loadError && <p className="muted">Loading campaigns…</p>}

          {campaigns && !campaigns.length && (
            <>
              <p className="muted">
                No campaign targets this source yet. Create one on the Campaigns tab with this source as its target,
                then come back.
              </p>
              <button type="button" className="secondary-btn" onClick={() => onOpenCampaigns()}>
                Go to Campaigns →
              </button>
            </>
          )}

          {campaigns && campaigns.length > 0 && (
            <>
              <label className="form-row">
                Campaign
                <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                  {campaigns.map((c) => (
                    <option key={c._id} value={c._id}>
                      {c.name}
                      {c.active ? "" : " (paused)"}
                    </option>
                  ))}
                </select>
              </label>
              {selected && !selected.active && (
                <p className="notice">
                  This campaign is paused — leads move in now but receive nothing until it's resumed.
                </p>
              )}
              <div className="form-actions">
                <button type="button" onClick={handleMove} disabled={busy || !campaignId}>
                  {busy ? "Moving…" : `Move ${matchCount} lead${matchCount === 1 ? "" : "s"}`}
                </button>
              </div>
            </>
          )}

          {error && <p className="error">{error}</p>}
          {result && (
            <p className="notice">
              Moved {result.enrolled} lead{result.enrolled === 1 ? "" : "s"} into "{result.campaignName}"
              {result.alreadyEnrolled > 0 && ` · ${result.alreadyEnrolled} already enrolled`}
              {result.skippedNoPhone + result.skippedBadPhone > 0 &&
                ` · ${result.skippedNoPhone + result.skippedBadPhone} skipped (no/invalid phone)`}
              .{" "}
              <button type="button" className="link-btn" onClick={() => onOpenCampaigns(result.campaignId)}>
                Open campaign →
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
