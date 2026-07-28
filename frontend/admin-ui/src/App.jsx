import { useEffect, useState } from "react";
import ZohoTab from "./ZohoTab";
import CampaignsTab from "./CampaignsTab";
import IntegrationsTab from "./IntegrationsTab";
import DataSourcesTab from "./DataSourcesTab";
import LeadMagnetDataTab from "./LeadMagnetDataTab";
import { fetchDataSources } from "./api";

export default function App() {
  const [tab, setTab] = useState("zoho");
  const [dataSources, setDataSources] = useState([]);

  function reloadDataSources() {
    fetchDataSources()
      .then((all) => setDataSources(all.filter((ds) => ds.active)))
      .catch(() => setDataSources([]));
  }

  useEffect(reloadDataSources, []);

  return (
    <div className="page">
      <div className="app-header">
        <h1>Leads</h1>
        <span className="muted">Contacts, campaigns &amp; integrations</span>
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
        <button type="button" className={`tab ${tab === "campaigns" ? "active" : ""}`} onClick={() => setTab("campaigns")}>
          Campaigns
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
        (ds) => tab === `ds-${ds._id}` && <LeadMagnetDataTab key={ds._id} dataSourceId={ds._id} label={ds.label} />
      )}
      {tab === "campaigns" && <CampaignsTab />}
      {tab === "data-sources" && <DataSourcesTab onChanged={reloadDataSources} />}
      {tab === "integrations" && <IntegrationsTab />}
    </div>
  );
}
