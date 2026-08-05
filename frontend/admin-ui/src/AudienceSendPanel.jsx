import { useCallback, useEffect, useMemo, useState } from "react";
import { previewCampaignSend, enrollCampaign, fetchSegmentMembers, publishCampaign, updateCampaign } from "./api";
import { describeFilter } from "./FilterBuilder";
import { graphsEqual, findLiveGraph } from "./graphCompare";
import { validateGraph } from "./graphValidation";
import { useSourceColumns } from "./sourceColumns";
import LeadsTable from "./LeadsTable";
import Pager from "./Pager";
import ConfirmDialog from "./ConfirmDialog";

/**
 * Audience & Send: who the *published* graph will enrol, and the button that
 * enrols them.
 *
 * This panel used to open with a "Build a segment" condition builder whose
 * filter it posted to /preview and /enroll. That stopped working when
 * campaigns became graphs: the audience moved onto each source node's
 * `config.filter` (edited on the canvas, see SourcePanel in
 * NodeConfigPanel.jsx), and the endpoints now reject a filter in the body
 * outright (assertNoBodyFilter, routes/campaigns.js). So the builder's only
 * two outcomes were "add a condition and the send 400s" or "add none and the
 * control did nothing" — while sitting at the top of the screen looking like
 * the main event.
 *
 * The rule this rewrite follows: audience is *edited* in one place (the
 * canvas) and only *shown* here. Everything on this screen is read back from
 * the same preview the confirm button is about to act on, so what is on screen
 * and what will happen cannot drift apart.
 */

// The engine sweeps for due enrollments on a timer rather than sending on the
// click (CAMPAIGN_POLL_INTERVAL_MS, default 5 minutes — see
// lib/campaignEngine.js). Not knowing this is the single most common "did my
// send work?" panic, so the success panel says it out loud. Worded as a
// default rather than a fact because the interval is an env var this UI cannot
// read.
const POLL_DELAY_SENTENCE =
  "Messages don't leave the instant you click — a scheduler sweeps for newly enrolled leads on a timer (every 5 minutes unless that default was changed), so expect a short wait before the first one goes out.";

// Which skipped-count rows are worth a line, and what to call them. Kept as
// data so a card renders only the ones that are non-zero: a wall of "0
// skipped" rows buries the one number that isn't zero.
const SKIP_ROWS = [
  { key: "alreadyEnrolled", label: "already enrolled" },
  { key: "skippedNoPhone", label: "skipped — no phone number" },
  { key: "skippedBadPhone", label: "skipped — phone number not usable" },
  { key: "skippedOptedOut", label: "skipped — opted out" },
  { key: "skippedDuplicate", label: "skipped — already counted under another source" },
];

/**
 * One source node's contribution to the send.
 *
 * Its own component rather than a loop body because it calls useSourceColumns
 * and owns its own members paging — a hook cannot run in a loop, and the
 * people table is fetched only when opened, so opening the tab stays one
 * request no matter how many sources the graph has.
 */
function SourceAudienceCard({ counts, sourceLabel, entryLabel, canonicalMap }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [members, setMembers] = useState({ members: [], total: 0, totalPages: 1 });
  const [membersError, setMembersError] = useState(null);
  const [loading, setLoading] = useState(false);

  const columns = useSourceColumns(open ? counts.sourceId : "", canonicalMap);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoading(true);
    setMembersError(null);
    fetchSegmentMembers(counts.sourceId, counts.filter, page)
      .then((d) => !cancelled && setMembers(d))
      .catch((err) => !cancelled && setMembersError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // counts.filter is a fresh object each preview; its content is what
    // matters, so it is keyed by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, counts.sourceId, JSON.stringify(counts.filter), page]);

  const skips = SKIP_ROWS.filter((r) => counts[r.key] > 0);

  return (
    <div className="audience-source-card">
      <div className="audience-source-head">
        <h4>{sourceLabel}</h4>
        <span className="muted">Filter: {describeFilter(counts.filter)}</span>
        <span className="muted">Leads start at: {entryLabel}</span>
      </div>

      {counts.matched === 0 ? (
        <p className="muted audience-source-empty">0 matched — nobody in this source to send to.</p>
      ) : (
        <>
          <div className="audience-counts">
            <span className="audience-count-headline">
              <strong>{counts.willEnroll}</strong> will be enrolled
            </span>
            <span className="muted">out of {counts.matched} matched</span>
          </div>
          {skips.length > 0 && (
            <ul className="audience-skip-list">
              {skips.map((r) => (
                <li key={r.key}>
                  <span className="audience-skip-count">{counts[r.key]}</span> {r.label}
                </li>
              ))}
            </ul>
          )}

          <button type="button" className="link-btn" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide the people" : `Show the ${counts.matched} ${counts.matched === 1 ? "person" : "people"}`}
          </button>

          {open && (
            <div className="audience-members">
              <Pager
                page={members.page || page}
                totalPages={members.totalPages || 1}
                total={members.total || 0}
                onChange={setPage}
              />
              <LeadsTable columns={columns} rows={members.members || []} loading={loading} error={membersError} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function AudienceSendPanel({
  campaign,
  // The full detail shape (draft + versions[] + liveVersion). Null until the
  // detail fetch resolves — the panel shows a loading line rather than
  // guessing at a graph it hasn't seen.
  fullCampaign,
  sourceLabels,
  onChanged,
  onGoToTab,
  onEnrolled,
  onPublished,
  sendingEnabled,
  sendingBusy,
  onToggleSending,
}) {
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [previewAt, setPreviewAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Seeded from the campaign so re-sending an already-armed campaign doesn't
  // silently disarm it, and re-synced because the panel stays mounted across
  // reloads.
  const [armAuto, setArmAuto] = useState(Boolean(campaign.autoEnroll));
  useEffect(() => setArmAuto(Boolean(campaign.autoEnroll)), [campaign._id, campaign.autoEnroll]);

  const [showConfirm, setShowConfirm] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [sendResult, setSendResult] = useState(null);

  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPreview(null);
    setPreviewError(null);
    previewCampaignSend(campaign._id)
      .then((r) => {
        if (cancelled) return;
        setPreview(r);
        setPreviewAt(new Date());
      })
      .catch((err) => !cancelled && setPreviewError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [campaign._id, refreshNonce]);

  // Reset the success panel when the campaign under it changes, so opening a
  // different campaign never shows the previous one's send result.
  useEffect(() => {
    setSendResult(null);
    setSendError(null);
  }, [campaign._id]);

  const liveVersion = fullCampaign ? fullCampaign.liveVersion : campaign.liveVersion;

  // nodeId -> label for the live published version. Enrolments enter on the
  // published graph, so the entry node named on each card has to be read from
  // that version and not from the draft, where the same id may now carry a
  // different label (or not exist).
  const liveNodes = useMemo(() => {
    const live = fullCampaign ? findLiveGraph(fullCampaign) : null;
    return (live && live.nodes) || [];
  }, [fullCampaign]);

  const nodeLabel = useCallback(
    (id) => {
      const node = liveNodes.find((n) => n.id === id);
      return (node && (node.label || node.id)) || id;
    },
    [liveNodes]
  );

  // The canonical field map belongs to the source node, and the preview
  // payload doesn't carry it — it comes off the same published version.
  const mapForNode = useCallback(
    (nodeId) => {
      const node = liveNodes.find((n) => n.id === nodeId);
      return (node && node.config && node.config.map) || {};
    },
    [liveNodes]
  );

  // Same question CampaignStatus asks, for a different purpose: there it
  // describes the mismatch, here it warns that Send acts on the published
  // version rather than on what is drawn in the Flow tab.
  const liveGraph = fullCampaign ? findLiveGraph(fullCampaign) : null;
  const draftDiffers = Boolean(liveGraph) && !graphsEqual(fullCampaign.draft, liveGraph);

  // Publishing from here publishes the *saved* draft, so it has to clear the
  // same validation gate the canvas's own Publish button clears — otherwise
  // this button would be a way to make a broken graph live without ever seeing
  // the errors that block it on the canvas.
  const draftErrors = useMemo(
    () => (fullCampaign ? validateGraph(fullCampaign.draft).errors : []),
    [fullCampaign]
  );

  async function handlePublish() {
    setPublishError(null);
    setPublishing(true);
    try {
      const published = await publishCampaign(campaign._id);
      onPublished?.(published);
      setRefreshNonce((n) => n + 1);
    } catch (err) {
      setPublishError(err.message);
    } finally {
      setPublishing(false);
    }
  }

  async function confirmSend() {
    setSendError(null);
    setSending(true);
    try {
      const result = await enrollCampaign(campaign._id, armAuto);
      setSendResult(result);
      onEnrolled?.(result);
      // Arming writes autoEnroll/autoEnrollFilter onto the campaign, and the
      // status strip above reads them off the campaign document — so it has to
      // be refetched for the change to be visible without a page reload.
      if (armAuto) onChanged();
    } catch (err) {
      setSendError(err.message);
    } finally {
      setSending(false);
      setShowConfirm(false);
    }
  }

  async function disarmAuto() {
    setSendError(null);
    try {
      await updateCampaign(campaign._id, { autoEnroll: false });
      onChanged();
    } catch (err) {
      setSendError(err.message);
    }
  }

  if (!fullCampaign) return <p className="muted">Loading this campaign's flow…</p>;

  // --- Can't send at all ---------------------------------------------------
  //
  // Every one of these comes back from /preview as a 400 whose `detail` is
  // already written for a human ("Source node X is not connected to anything.
  // Wire it to the node its leads should start on"), so it is shown verbatim
  // rather than translated into a vaguer sentence here. Nothing else renders:
  // empty count cards and a greyed-out Send button next to an error is a
  // screen that asks the reader to work out which part is the real message.
  if (previewError) {
    return (
      <div className="audience-blocked">
        <h4>This campaign can&apos;t send yet</h4>
        <p>{previewError}</p>
        <p className="muted">Fix it on the canvas, publish, and this page will be able to count your audience.</p>
        <button type="button" onClick={() => onGoToTab("flow")}>
          Open the Flow tab
        </button>
      </div>
    );
  }

  return (
    <div className="audience-panel">
      {draftDiffers && (
        <div className="notice audience-draft-notice">
          <strong>Your saved draft differs from what is live.</strong> This send enrols people onto published version{" "}
          {liveVersion} — not the flow you see on the canvas. Leads already walking version {liveVersion} stay on it
          either way.
          <div className="audience-draft-actions">
            {draftErrors.length === 0 ? (
              <button type="button" onClick={handlePublish} disabled={publishing}>
                {publishing ? "Publishing…" : `Publish the draft as v${(liveVersion || 0) + 1}`}
              </button>
            ) : (
              <span className="muted">
                The draft has {draftErrors.length} error{draftErrors.length === 1 ? "" : "s"} and can&apos;t be
                published — open the Flow tab to see them.
              </span>
            )}
            <button type="button" className="secondary-btn" onClick={() => onGoToTab("flow")}>
              Go to Flow
            </button>
          </div>
          {publishError && <p className="error">{publishError}</p>}
        </div>
      )}

      {sendResult ? (
        // --- After a send ----------------------------------------------------
        <div className="audience-success">
          {sendingEnabled === false ? (
            <>
              <h4>{sendResult.enrolled} enrolled — but nothing will actually send</h4>
              <p>
                Global sending is off, so these leads are queued and will sit there. Turn it on and the scheduler picks
                them up on its next sweep.
              </p>
              <button type="button" onClick={onToggleSending} disabled={sendingBusy}>
                {sendingBusy ? "Turning on…" : "Turn sending on"}
              </button>
            </>
          ) : (
            <>
              <h4>{sendResult.enrolled} people enrolled</h4>
              <p>{POLL_DELAY_SENTENCE}</p>
            </>
          )}
          <p className="muted">
            {sendResult.autoEnroll
              ? "Auto-enroll is on: anyone who matches these sources later joins this campaign by themselves."
              : "One-off send: only the people counted above were enrolled. Anyone added to a source later is not."}
          </p>
          <div className="form-actions">
            <button type="button" onClick={() => onGoToTab("results")}>
              See results
            </button>
            <button
              type="button"
              className="secondary-btn"
              onClick={() => {
                setSendResult(null);
                setRefreshNonce((n) => n + 1);
              }}
            >
              Send to more
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="audience-toolbar">
            <span className="muted">
              Sending version {liveVersion} (live)
              {previewAt && ` · counted ${previewAt.toLocaleTimeString()}`}
            </span>
            <button
              type="button"
              className="secondary-btn"
              onClick={() => setRefreshNonce((n) => n + 1)}
              disabled={loading}
            >
              {loading ? "Counting…" : "Refresh"}
            </button>
          </div>

          {loading && <p className="muted">Counting your audience…</p>}

          {preview &&
            (preview.sources || []).map((s) => (
              <SourceAudienceCard
                key={s.nodeId}
                counts={s}
                sourceLabel={sourceLabels[s.sourceId] || s.sourceId}
                entryLabel={nodeLabel(s.entryNodeId)}
                canonicalMap={mapForNode(s.nodeId)}
              />
            ))}

          {preview && (
            <p className="audience-total">
              <strong>{preview.willEnroll}</strong> {preview.willEnroll === 1 ? "person" : "people"} will be enrolled in
              total.
            </p>
          )}

          {/* Send is deliberately still enabled here. Enrolling nobody is a
              no-op the backend handles cleanly (0 upserts), and this is the
              only control that arms auto-enroll — so blocking it would trap
              the legitimate "everyone matching is already in, keep it running
              for the ones who arrive later" case. Saying so beats a button
              that quietly does nothing. */}
          {preview && preview.willEnroll === 0 && (
            <p className="muted">
              {preview.alreadyEnrolled > 0
                ? "Everyone who matches is already enrolled, so sending now adds nobody. It is still worth pressing if you want to change the option below."
                : "Nothing matches these sources right now, so sending enrols nobody."}
            </p>
          )}

          {/* One lever, one place. This replaces the old checkbox + explanatory
              paragraph + separate "turn off auto-enroll" link, which were three
              controls for the same decision at two points in time. */}
          <fieldset className="audience-run-choice" disabled={sending || loading}>
            <legend>How should this run?</legend>
            <label className="audience-run-option">
              <input type="radio" name="run-mode" checked={!armAuto} onChange={() => setArmAuto(false)} />
              <span>
                <strong>Send once</strong>
                <span className="muted">
                  Only the people counted above. Anyone added to a source later is not sent to.
                </span>
              </span>
            </label>
            <label className="audience-run-option">
              <input type="radio" name="run-mode" checked={armAuto} onChange={() => setArmAuto(true)} />
              <span>
                <strong>Send and keep running</strong>
                <span className="muted">
                  These people now, and anyone who matches later joins automatically on the scheduler&apos;s next sweep.
                </span>
              </span>
            </label>
          </fieldset>

          {sendError && <p className="error">{sendError}</p>}

          <div className="form-actions">
            <button type="button" onClick={() => setShowConfirm(true)} disabled={loading || sending || !preview}>
              {sending ? "Sending…" : "Send campaign"}
            </button>
          </div>

          {/* Only reachable for an already-armed campaign the operator wants to
              stop without doing another send — arming itself happens through
              the choice above, on a segment that was previewed. */}
          {campaign.autoEnroll && (
            <p className="muted">
              Auto-enroll is on right now.{" "}
              <button type="button" className="link-btn" onClick={disarmAuto}>
                Turn it off
              </button>
            </p>
          )}
        </>
      )}

      {showConfirm && preview && (
        <ConfirmDialog
          title={`Send "${campaign.name}"?`}
          confirmLabel="Send campaign"
          onConfirm={confirmSend}
          onCancel={() => setShowConfirm(false)}
        >
          <p>
            <strong>{preview.willEnroll}</strong> {preview.willEnroll === 1 ? "person" : "people"} will start getting
            WhatsApp messages.
          </p>
          <p>
            {armAuto
              ? "Keep running is on — anyone who matches these sources later will join automatically after this."
              : "One-off send — only these people, nobody added later."}
          </p>
          {sendingEnabled === false && (
            <p className="muted">Global sending is off, so they will be enrolled but nothing will go out yet.</p>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
