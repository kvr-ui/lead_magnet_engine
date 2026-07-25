import { useState } from "react";
import CaGuruTab from "./CaGuruTab";
import ZohoTab from "./ZohoTab";
import CampaignsTab from "./CampaignsTab";
import IntegrationsTab from "./IntegrationsTab";

export default function App() {
  const [tab, setTab] = useState("ca-guru");

  return (
    <div className="page">
      <h1>Leads</h1>
      <div className="tabs">
        <button type="button" className={`tab ${tab === "ca-guru" ? "active" : ""}`} onClick={() => setTab("ca-guru")}>
          CA Guru Leads
        </button>
        <button type="button" className={`tab ${tab === "zoho" ? "active" : ""}`} onClick={() => setTab("zoho")}>
          Zoho Contacts
        </button>
        <button type="button" className={`tab ${tab === "campaigns" ? "active" : ""}`} onClick={() => setTab("campaigns")}>
          Campaigns
        </button>
        <button type="button" className={`tab ${tab === "integrations" ? "active" : ""}`} onClick={() => setTab("integrations")}>
          Integrations
        </button>
      </div>
      {tab === "ca-guru" && <CaGuruTab />}
      {tab === "zoho" && <ZohoTab />}
      {tab === "campaigns" && <CampaignsTab />}
      {tab === "integrations" && <IntegrationsTab />}
    </div>
  );
}
