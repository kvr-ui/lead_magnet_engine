import { useEffect, useState } from "react";
import ZohoTab from "./ZohoTab";
import CampaignsTab from "./CampaignsTab";
import MessageTrackingTab from "./MessageTrackingTab";
import IntegrationsTab from "./IntegrationsTab";
import DataSourcesTab from "./DataSourcesTab";
import LeadMagnetDataTab from "./LeadMagnetDataTab";
import SendingToggle from "./SendingToggle";
import { fetchDataSources, fetchSendingEnabled, setSendingEnabled as postSendingEnabled } from "./api";

export default function App() {
  const [tab, setTab] = useState("zoho");
  const [dataSources, setDataSources] = useState([]);
  // Set when arriving from "Move to campaign" on a leads tab, so the campaign
  // the leads landed in opens directly instead of the campaign list.
  const [campaignFocusId, setCampaignFocusId] = useState(null);

  // The global sending kill switch. Lifted here from SendingToggle (which
  // used to own and fetch this itself) so the campaigns tab's status strip
  // can read and drive the same state — there is exactly one fetch of it,
  // on mount, right here; nothing else polls it.
  const [sendingEnabled, setSendingEnabledState] = useState(null);
  const [sendingQueued, setSendingQueued] = useState(0);
  const [sendingBusy, setSendingBusy] = useState(false);
  const [sendingError, setSendingError] = useState(null);

  useEffect(() => {
    fetchSendingEnabled()
      .then((d) => {
        setSendingEnabledState(d.enabled);
        setSendingQueued(d.queued);
      })
      .catch((err) => setSendingError(err.message));
  }, []);

  async function toggleSending() {
    const next = !sendingEnabled;
    // Turning it on releases everything already queued — say how much before
    // it happens, not after.
    if (next) {
      const warning = sendingQueued
        ? `Turn sending ON?\n\n${sendingQueued} lead(s) are already queued in active campaigns and will start receiving real WhatsApp messages within a few minutes.`
        : "Turn sending ON?\n\nCampaign messages will be sent for real from now on.";
      if (!window.confirm(warning)) return;
    }

    setSendingError(null);
    setSendingBusy(true);
    try {
      const d = await postSendingEnabled(next);
      setSendingEnabledState(d.enabled);
      setSendingQueued(d.queued);
    } catch (err) {
      setSendingError(err.message);
    } finally {
      setSendingBusy(false);
    }
  }

  function reloadDataSources() {
    fetchDataSources()
      .then((all) => setDataSources(all.filter((ds) => ds.active)))
      .catch(() => setDataSources([]));
  }

  useEffect(reloadDataSources, []);

  function openCampaigns(campaignId = null) {
    setCampaignFocusId(campaignId);
    setTab("campaigns");
  }

  return (
    <div className="page">
      <div className="app-header">
        <h1>Leads</h1>
        <div className="app-header-right">
          <span className="muted">Contacts, campaigns &amp; integrations</span>
          <SendingToggle
            enabled={sendingEnabled}
            queued={sendingQueued}
            busy={sendingBusy}
            error={sendingError}
            onToggle={toggleSending}
          />
        </div>
      </div>
      <div className="tabs">
        <button type="button" className={`tab ${tab === "zoho" ? "active" : ""}`} onClick={() => setTab("zoho")}>
          Zoho Contacts
        </button>
        {dataSources.map((ds) => (
          <button
            type="button"
            key={ds._id}
            className={`tab ${tab === `ds-${ds._id}` ? "active" : ""}`}
            onClick={() => setTab(`ds-${ds._id}`)}
          >
            {ds.label}
          </button>
        ))}
        <button type="button" className={`tab ${tab === "campaigns" ? "active" : ""}`} onClick={() => openCampaigns()}>
          Campaigns
        </button>
        <button
          type="button"
          className={`tab ${tab === "message-tracking" ? "active" : ""}`}
          onClick={() => setTab("message-tracking")}
        >
          Message Tracking
        </button>
        <button type="button" className={`tab ${tab === "data-sources" ? "active" : ""}`} onClick={() => setTab("data-sources")}>
          Data Sources
        </button>
        <button type="button" className={`tab ${tab === "integrations" ? "active" : ""}`} onClick={() => setTab("integrations")}>
          Integrations
        </button>
      </div>
      {tab === "zoho" && <ZohoTab />}
      {dataSources.map(
        (ds) =>
          tab === `ds-${ds._id}` && (
            <LeadMagnetDataTab key={ds._id} dataSourceId={ds._id} label={ds.label} onOpenCampaigns={openCampaigns} />
          )
      )}
      {tab === "campaigns" && (
        <CampaignsTab
          focusCampaignId={campaignFocusId}
          sendingEnabled={sendingEnabled}
          sendingQueued={sendingQueued}
          sendingBusy={sendingBusy}
          onToggleSending={toggleSending}
        />
      )}
      {tab === "message-tracking" && <MessageTrackingTab />}
      {tab === "data-sources" && <DataSourcesTab onChanged={reloadDataSources} />}
      {tab === "integrations" && <IntegrationsTab />}
    </div>
  );
}
