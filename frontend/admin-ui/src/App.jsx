import { useState } from "react";
import CaGuruTab from "./CaGuruTab";
import ZohoTab from "./ZohoTab";

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
      </div>
      {tab === "ca-guru" ? <CaGuruTab /> : <ZohoTab />}
    </div>
  );
}
