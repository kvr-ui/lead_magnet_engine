import { useEffect, useState } from "react";
import FilterCondition, { buildMongoFilter } from "./FilterBuilder";
import { fetchFilterFields, fetchTemplates } from "./api";

// Reverse of buildMongoFilter (FilterBuilder.jsx): turns a stored Mongo-ish
// filter object back into the array of { field, values, cmp } rows
// FilterCondition edits, so reopening a node shows what was saved instead of
// starting the editor blank. Handles exactly the two shapes buildMongoFilter
// ever produces ({ $in: [...] } and a single { $op: value } comparison) - not
// a general Mongo query parser.
function filterToConditions(filter) {
  return Object.entries(filter || {}).map(([field, value]) => {
    if (value && typeof value === "object" && Array.isArray(value.$in)) {
      return { field, values: value.$in };
    }
    if (value && typeof value === "object") {
      const [op] = Object.keys(value);
      return { field, values: [], cmp: { op, value: value[op] } };
    }
    return { field, values: [value] };
  });
}

// Shared by the source node's filter, the filter node, and the condition
// node's field-based case - all three write the same Mongo-ish filter shape
// via buildMongoFilter, driven by FilterCondition. Neither is modified: both
// are imported and used exactly as CampaignDetail's segment builder uses them.
function FilterEditor({ source, filter, onChange }) {
  const [conditions, setConditions] = useState(() => filterToConditions(filter));

  function update(next) {
    setConditions(next);
    onChange(buildMongoFilter(next));
  }

  return (
    <div>
      {conditions.map((c, i) => (
        <FilterCondition
          key={i}
          source={source}
          condition={c}
          // Every condition except this one, so each row's counts are taken
          // within the segment the rest of them define. Built by the same
          // function that builds the saved filter, so the numbers on the chips
          // and the leads the filter actually selects can't drift apart. This
          // row is left out on purpose: a field narrowed by its own selection
          // would offer only the values already picked.
          narrowBy={buildMongoFilter(conditions.filter((_, idx) => idx !== i))}
          onChange={(next) => update(conditions.map((cc, idx) => (idx === i ? next : cc)))}
          onRemove={() => update(conditions.filter((_, idx) => idx !== i))}
        />
      ))}
      <button type="button" className="link-btn" onClick={() => update([...conditions, { field: "", values: [] }])}>
        + add condition
      </button>
      {!conditions.length && <p className="muted">No conditions — matches everyone from this source.</p>}
    </div>
  );
}

const CANONICAL_BASE_KEYS = ["phone", "name", "email"];

// source node: pick which source feeds this branch of the graph, map its
// fields onto canonical keys (phone required), and the filter that narrows it.
function SourcePanel({ node, sources, onChangeConfig }) {
  const config = node.config || {};
  const [fields, setFields] = useState([]);
  const [fieldsError, setFieldsError] = useState(null);
  const [customKey, setCustomKey] = useState("");

  useEffect(() => {
    setFields([]);
    setFieldsError(null);
    if (!config.sourceId) return;
    fetchFilterFields(config.sourceId)
      .then((d) => setFields(d.fields))
      .catch((err) => setFieldsError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.sourceId]);

  const map = config.map || {};
  const extraKeys = Object.keys(map).filter((k) => !CANONICAL_BASE_KEYS.includes(k));
  const phoneMissing = !map.phone;

  function setSourceId(sourceId) {
    // A different source has different fields - both the map and the filter
    // built for the old one would silently point at columns that don't exist
    // on the new one, so both reset together.
    onChangeConfig({ ...config, sourceId, map: {}, filter: {} });
  }
  function setMapField(key, field) {
    onChangeConfig({ ...config, map: { ...map, [key]: field } });
  }
  function removeCustomKey(key) {
    const nextMap = { ...map };
    delete nextMap[key];
    onChangeConfig({ ...config, map: nextMap });
  }
  function addCustomKey() {
    const key = customKey.trim();
    if (!key || map[key] !== undefined) return;
    onChangeConfig({ ...config, map: { ...map, [key]: "" } });
    setCustomKey("");
  }
  function setFilter(filter) {
    onChangeConfig({ ...config, filter });
  }

  return (
    <div>
      <label className="form-row">
        Source
        <select value={config.sourceId || ""} onChange={(e) => setSourceId(e.target.value)}>
          <option value="">Pick a source…</option>
          {sources.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>

      {fieldsError && <p className="error">{fieldsError}</p>}

      {config.sourceId && (
        <>
          <h4>Field mapping</h4>
          {CANONICAL_BASE_KEYS.map((key) => (
            <label className="form-row" key={key}>
              {key === "phone" ? (
                <>
                  Phone <span className="field-required">*required</span>
                </>
              ) : (
                key.charAt(0).toUpperCase() + key.slice(1)
              )}
              <select value={map[key] || ""} onChange={(e) => setMapField(key, e.target.value)}>
                <option value="">— not mapped —</option>
                {fields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
              {key === "phone" && phoneMissing && (
                <span className="field-error">Phone mapping is required before this node can be saved.</span>
              )}
            </label>
          ))}

          {extraKeys.map((key) => (
            <label className="form-row" key={key}>
              {key}
              <div className="param-row">
                <select value={map[key] || ""} onChange={(e) => setMapField(key, e.target.value)}>
                  <option value="">— not mapped —</option>
                  {fields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <button type="button" className="link-btn danger" onClick={() => removeCustomKey(key)}>
                  remove
                </button>
              </div>
            </label>
          ))}

          <div className="param-row">
            <input
              placeholder="custom canonical key (e.g. city)"
              value={customKey}
              onChange={(e) => setCustomKey(e.target.value)}
            />
            <button type="button" className="secondary-btn" onClick={addCustomKey}>
              + add key
            </button>
          </div>

          <h4>Filter</h4>
          <FilterEditor key={config.sourceId} source={config.sourceId} filter={config.filter} onChange={setFilter} />
        </>
      )}
    </div>
  );
}

// filter node: narrows who continues past this point in the graph.
function FilterPanel({ node, defaultFilterSource, onChangeConfig }) {
  const config = node.config || {};
  function setFilter(filter) {
    onChangeConfig({ ...config, filter });
  }
  return (
    <div>
      <p className="muted">Only leads matching this filter continue past this node.</p>
      <FilterEditor key={node.id} source={defaultFilterSource} filter={config.filter} onChange={setFilter} />
    </div>
  );
}

// message node: which template, and which canonical key fills each of its
// variable slots.
// "template" unless the node says otherwise — the same default the walker
// applies, so a graph drawn before free text existed reads back unchanged.
function messageTypeOf(config) {
  return String(config.type || config.messageType || "template").toLowerCase() === "text" ? "text" : "template";
}

function MessagePanel({ node, onChangeConfig, canonicalKeySuggestions }) {
  const config = node.config || {};
  const [templates, setTemplates] = useState([]);
  const [templatesError, setTemplatesError] = useState(null);
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    fetchTemplates()
      .then((d) => {
        setTemplates(d.templates);
        if (d.connected === false) setConnected(false);
      })
      .catch((err) => setTemplatesError(err.message));
  }, []);

  const params = config.params || [];
  const datalistId = `canonical-keys-${node.id}`;
  const messageType = messageTypeOf(config);

  function setMessageType(type) {
    onChangeConfig({ ...config, type });
  }
  function setText(text) {
    onChangeConfig({ ...config, text });
  }
  function setTemplateId(templateId) {
    onChangeConfig({ ...config, templateId });
  }
  function setBroadcastName(broadcastName) {
    onChangeConfig({ ...config, providerMeta: { ...(config.providerMeta || {}), broadcastName } });
  }
  function updateParam(i, patch) {
    onChangeConfig({ ...config, params: params.map((p, idx) => (idx === i ? { ...p, ...patch } : p)) });
  }
  function addParam() {
    const nextIndex = params.length ? Math.max(...params.map((p) => Number(p.index) || 0)) + 1 : 1;
    onChangeConfig({ ...config, params: [...params, { index: nextIndex, from: "" }] });
  }
  function removeParam(i) {
    onChangeConfig({ ...config, params: params.filter((_, idx) => idx !== i) });
  }

  return (
    <div>
      {!connected && <p className="error">No WhatsApp provider connected — connect one from the Integrations tab.</p>}
      {templatesError && <p className="error">{templatesError}</p>}

      <label className="form-row">
        Send as
        <select value={messageType} onChange={(e) => setMessageType(e.target.value)}>
          <option value="template">Approved template — reaches anyone, any time</option>
          <option value="text">Free text — only inside the 24-hour window</option>
        </select>
      </label>

      {messageType === "text" ? (
        <>
          <p className="muted">
            WhatsApp allows a free-typed message only within 24 hours of the lead's last reply. Leads whose window has
            closed are paused here rather than sent to, and resume automatically the next time the lead messages us —
            but put a <strong>Conversation window</strong> condition in front of this node to route them to a template
            instead of leaving them waiting.
          </p>
          <label className="form-row">
            Message text
            <textarea
              rows={6}
              value={config.text || ""}
              placeholder={"Hi {{name}}, still stuck on the last question? Reply here and I'll help."}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <p className="muted">
            Use {"{{key}}"} to drop in a canonical key from the source's field map
            {canonicalKeySuggestions.length ? ` (${canonicalKeySuggestions.slice(0, 6).join(", ")}…)` : ""}. A key the
            lead has no value for renders as nothing.
          </p>
        </>
      ) : (
        <>
          <label className="form-row">
            Template
            <select value={config.templateId || ""} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Pick a template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id}
                  {t.status ? ` (${t.status})` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="form-row">
            Broadcast name
            <input value={config.providerMeta?.broadcastName || ""} onChange={(e) => setBroadcastName(e.target.value)} />
          </label>

          <h4>Template parameters</h4>
          <p className="muted">Map each template variable ({"{{1}}, {{2}}, …"}) to a canonical key from the source's field map.</p>
          <datalist id={datalistId}>
            {canonicalKeySuggestions.map((k) => (
              <option value={k} key={k} />
            ))}
          </datalist>
          {params.map((p, i) => (
            <div className="param-row" key={i}>
              <input
                type="number"
                min="1"
                style={{ width: "4rem" }}
                value={p.index}
                onChange={(e) => updateParam(i, { index: Number(e.target.value) || 1 })}
              />
              <input
                list={datalistId}
                placeholder="canonical key (e.g. name)"
                value={p.from || ""}
                onChange={(e) => updateParam(i, { from: e.target.value })}
              />
              <button type="button" className="link-btn danger" onClick={() => removeParam(i)}>
                remove
              </button>
            </div>
          ))}
          <button type="button" className="secondary-btn" onClick={addParam}>
            + add parameter
          </button>
        </>
      )}
    </div>
  );
}

const WEEKDAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

// wait node: amount/unit, a send-window, and weekday skip-days.
function WaitPanel({ node, onChangeConfig }) {
  const config = node.config || {};
  const win = config.window || {};
  const skipDays = config.skipDays || [];

  function set(patch) {
    onChangeConfig({ ...config, ...patch });
  }
  function setWindow(patch) {
    onChangeConfig({ ...config, window: { ...win, ...patch } });
  }
  function toggleSkipDay(day) {
    const next = skipDays.includes(day) ? skipDays.filter((d) => d !== day) : [...skipDays, day].sort((a, b) => a - b);
    onChangeConfig({ ...config, skipDays: next });
  }

  return (
    <div>
      <label className="form-row">
        Amount
        <input type="number" min="0" value={config.amount ?? ""} onChange={(e) => set({ amount: Number(e.target.value) || 0 })} />
      </label>
      <label className="form-row">
        Unit
        <select value={config.unit || "hours"} onChange={(e) => set({ unit: e.target.value })}>
          <option value="minutes">minutes</option>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
      </label>

      <h4>Send window</h4>
      <label className="form-row">
        From
        <input type="time" value={win.from || ""} onChange={(e) => setWindow({ from: e.target.value })} />
      </label>
      <label className="form-row">
        To
        <input type="time" value={win.to || ""} onChange={(e) => setWindow({ to: e.target.value })} />
      </label>
      <label className="form-row">
        Timezone
        <input placeholder="e.g. Asia/Kolkata" value={win.tz || ""} onChange={(e) => setWindow({ tz: e.target.value })} />
      </label>

      <h4>Skip days</h4>
      <div className="value-chip-row">
        {WEEKDAYS.map((d) => (
          <label className="checkbox-row" key={d.value}>
            <input type="checkbox" checked={skipDays.includes(d.value)} onChange={() => toggleSkipDay(d.value)} />
            {d.label}
          </label>
        ))}
      </div>
    </div>
  );
}

// condition node: `config.on` picks which of five questions the node asks, and
// evaluateCondition() in lib/campaignEngine.js dispatches on it. Each kind
// reads its own keys:
//
//   field      { filter }             - compare the lead record, the same
//                                       Mongo-ish shape a filter node writes
//   engagement { nodeId, status }     - did one specific message land, get read,
//                                       or get answered
//   activity   { metric, threshold }  - did they use the lead magnet since we
//                                       last messaged them
//   elapsed    { since, days, hours } - how long since the drip started, or
//                                       since the last send
//   window     {}                     - is the lead's 24h conversation window
//                                       open right now
//   reply      { since }              - did the lead send us anything at all
//                                       since our last send (or since enrolling)
//
// Only "field" had a form before. The others were implemented in the walker but
// unreachable from the canvas, which is what made a follow-up that chases only
// the leads who *didn't* reply impossible to build here.
const CONDITION_KINDS = [
  { value: "field", label: "Lead field", hint: "compare a field on the lead record" },
  { value: "engagement", label: "Message engagement", hint: "did a message land, get read, or get a reply" },
  { value: "reply", label: "Lead replied", hint: "any inbound message from the lead" },
  { value: "activity", label: "Product activity", hint: "did they use the lead magnet" },
  { value: "elapsed", label: "Time elapsed", hint: "how long since the drip started" },
  { value: "window", label: "Conversation window", hint: "can we send free text right now" },
];

// ENGAGEMENT_STATUSES in lib/campaignEngine.js, in funnel order. Each names a
// normalized MessageEvent status the WATI webhook records. A condition asks
// about exactly one of them, so "read or replied" is two chained conditions
// rather than a multi-select - which is why the copy below names the single
// status rather than talking about engagement in general.
const ENGAGEMENT_STATUSES = [
  { value: "sent", label: "Sent", hint: "handed to the provider" },
  { value: "delivered", label: "Delivered", hint: "reached the handset" },
  { value: "read", label: "Read", hint: "opened by the lead" },
  { value: "replied", label: "Replied", hint: "the lead answered it" },
  { value: "failed", label: "Failed", hint: "Meta rejected it, or it could not be delivered" },
];

// Shared by the condition node's "activity" case and the goal node below: both
// read the same rollup from lib/leadActivity.js, so they must offer the same
// metrics or the two would disagree about what counts as activity.
const ACTIVITY_METRICS = [
  { value: "count", label: "Activity rows", hint: "anything the lead did" },
  { value: "correct", label: "Correct answers", hint: "rows flagged correct" },
  { value: "graded", label: "Graded answers", hint: "rows that were marked at all" },
];

const ELAPSED_SINCE = [
  { value: "start", label: "the enrollment started" },
  { value: "lastsend", label: "the last message we sent" },
];

// evaluateEngagement() accepts older spellings of both its keys. Read all of
// them so a graph written by hand still opens with its selection intact, and
// write only the canonical `nodeId` / `status` back.
function engagementNodeIdOf(config) {
  return config.nodeId || config.messageNodeId || config.node || "";
}

function engagementStatusOf(config) {
  return String(config.status || config.event || "").toLowerCase();
}

function ConditionPanel({ node, messageNodes, defaultFilterSource, onChangeConfig }) {
  const config = node.config || {};
  const on = String(config.on || "field").toLowerCase();

  function set(patch) {
    onChangeConfig({ ...config, ...patch });
  }

  // Only the discriminator changes, exactly as ActionPanel's setMode does and
  // for the same reason: the walker dispatches on `on` alone, so the other
  // kinds' keys are inert, and leaving them in place means switching away and
  // back doesn't discard a filter that was already built.
  function setKind(next) {
    // Except for engagement's status, which is defaulted on arrival rather than
    // left blank: a status is required, and "replied" is the one this node
    // exists to ask about.
    if (next === "engagement" && !engagementStatusOf(config)) return set({ on: next, status: "replied" });
    set({ on: next });
  }

  const selectedMessage = engagementNodeIdOf(config);
  // A reference to a node that no longer exists must stay visible rather than
  // letting the select silently snap to the first message node - which would
  // read as a valid configuration nobody chose. Kept as an explicit option, and
  // warned about by validateGraph.
  const messageMissing = Boolean(selectedMessage) && !messageNodes.some((m) => m.id === selectedMessage);

  return (
    <div>
      <label className="form-row">
        Ask about
        <select value={on} onChange={(e) => setKind(e.target.value)}>
          {CONDITION_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label} — {k.hint}
            </option>
          ))}
        </select>
      </label>

      {on === "field" && (
        <div>
          <p className="muted">Leads matching this filter take the “yes” branch; everyone else takes “no”.</p>
          <FilterEditor
            key={node.id}
            source={defaultFilterSource}
            filter={config.filter}
            onChange={(filter) => set({ filter })}
          />
        </div>
      )}

      {on === "engagement" && (
        <div>
          <p className="muted">
            Asks about one earlier message. Leads whose message reached the chosen status take the “yes” branch;
            everyone else takes “no”.
          </p>

          <label className="form-row">
            Message
            <select value={selectedMessage} onChange={(e) => set({ nodeId: e.target.value })}>
              <option value="">— pick a message node —</option>
              {messageMissing && <option value={selectedMessage}>{selectedMessage} (no longer in this flow)</option>}
              {messageNodes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label || m.id}
                </option>
              ))}
            </select>
            <span className="muted">
              Answered per message, not per phone number: it checks the provider's id for that specific send, so a reply
              to an earlier message doesn't count as a reply to this one.
            </span>
          </label>

          <label className="form-row">
            Reached status
            <select value={engagementStatusOf(config) || "replied"} onChange={(e) => set({ status: e.target.value })}>
              {ENGAGEMENT_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label} — {s.hint}
                </option>
              ))}
            </select>
          </label>

          <p className="muted">
            Put a <strong>wait</strong> node between that message and this one. Delivery and reply events arrive
            afterwards over the webhook, so a condition evaluated straight after a send finds nothing and routes
            everyone down “no”.
          </p>
          <p className="muted">
            Numbers Meta refused come back as <em>Failed</em>, and never received the message at all. Branching those
            separately keeps them out of a follow-up meant for leads who saw it and stayed quiet.
          </p>
        </div>
      )}

      {on === "reply" && (
        <div>
          <p className="muted">
            Leads who sent us anything at all — text, a photo, a voice note — take the “yes” branch; everyone else
            takes “no”.
          </p>
          <label className="form-row">
            Count replies since
            <select value={String(config.since || "lastSend")} onChange={(e) => set({ since: e.target.value })}>
              <option value="lastSend">the last message we sent</option>
              <option value="start">the enrollment started</option>
            </select>
          </label>
          <p className="muted">
            Asked per phone number, like the conversation-window condition: a reply to any campaign or to the chatbot
            counts. Use <strong>Message engagement</strong> instead when the question is “did they answer <em>that
            specific message</em>”.
          </p>
        </div>
      )}

      {on === "window" && (
        <div>
          <p className="muted">
            Leads who can be sent a free-typed message right now take the “yes” branch; everyone else takes “no”.
            WhatsApp opens a 24-hour window when the lead messages us, and nothing else opens one — not an enrollment,
            not a template we sent.
          </p>
          <p className="muted">
            Asked per phone number, not per message: a reply to any campaign, or to the chatbot, keeps the window open
            here too. Nothing to configure — the question has one answer.
          </p>
          <p className="muted">
            The usual shape is “yes” → a free-text message, “no” → an approved template.
          </p>
        </div>
      )}

      {on === "activity" && (
        <div>
          <p className="muted">
            Leads who cleared the threshold take the “yes” branch; everyone else takes “no”. Only activity recorded{" "}
            <em>after the last message this campaign sent them</em> counts.
          </p>

          <label className="form-row">
            Measure
            <select value={config.metric || "count"} onChange={(e) => set({ metric: e.target.value })}>
              {ACTIVITY_METRICS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label} — {m.hint}
                </option>
              ))}
            </select>
          </label>

          <label className="form-row">
            At least
            <input
              type="number"
              min="1"
              placeholder="1"
              value={config.threshold === undefined || config.threshold === null ? "" : config.threshold}
              onChange={(e) => set({ threshold: e.target.value === "" ? undefined : Number(e.target.value) })}
            />
          </label>

          <p className="muted">
            Needs a connected data source with an activity config (Data Sources tab). Without one this node can't answer
            its own question, so leads reaching it are parked rather than routed down “no”.
          </p>
        </div>
      )}

      {on === "elapsed" && (
        <div>
          <p className="muted">
            Leads for whom at least this much time has passed take the “yes” branch; everyone else takes “no”.
          </p>

          <label className="form-row">
            Measured since
            <select value={config.since === "lastsend" ? "lastsend" : "start"} onChange={(e) => set({ since: e.target.value })}>
              {ELAPSED_SINCE.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          <div className="form-row">
            <span>At least</span>
            <div className="value-chip-row">
              <label className="checkbox-row">
                <input
                  type="number"
                  min="0"
                  placeholder="0"
                  value={config.days === undefined || config.days === null ? "" : config.days}
                  onChange={(e) => set({ days: e.target.value === "" ? undefined : Number(e.target.value) })}
                />
                days
              </label>
              <label className="checkbox-row">
                <input
                  type="number"
                  min="0"
                  placeholder="0"
                  value={config.hours === undefined || config.hours === null ? "" : config.hours}
                  onChange={(e) => set({ hours: e.target.value === "" ? undefined : Number(e.target.value) })}
                />
                hours
              </label>
            </div>
            <span className="muted">
              Both left empty means no delay at all, which is true for every lead the moment they arrive.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// split node: { ratio } - the percentage of leads taking branch "a"; the rest
// take "b". Read by splitBranchFor() in lib/campaignEngine.js, which requires a
// finite 0-100 number and derives the branch from a stable hash of the lead's
// id, so the same lead always lands on the same side.
//
// There is deliberately no default: the walker refuses a split with no ratio
// rather than assuming 50, because a guessed ratio quietly invents an
// experiment nobody designed. This form therefore starts empty and says so.
function SplitPanel({ node, onChangeConfig }) {
  const config = node.config || {};
  const raw = config.ratio;
  const hasRatio = raw !== undefined && raw !== null && raw !== "" && Number.isFinite(Number(raw));
  const ratio = hasRatio ? Number(raw) : 50;

  function setRatio(value) {
    const next = Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
    onChangeConfig({ ...config, ratio: next });
  }

  return (
    <div>
      <p className="muted">
        Splits traffic between the two outgoing edges. Which side a lead lands on is derived from their own id, so the
        same lead always takes the same branch — re-running the flow never reshuffles a live A/B test.
      </p>

      <label className="form-row">
        Branch “a” share
        <div className="split-ratio-row">
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={ratio}
            onChange={(e) => setRatio(e.target.value)}
            aria-label="Percentage of leads taking branch a"
          />
          <input
            type="number"
            min="0"
            max="100"
            className="split-ratio-number"
            value={hasRatio ? ratio : ""}
            placeholder="—"
            onChange={(e) => setRatio(e.target.value)}
          />
          <span className="muted">%</span>
        </div>
      </label>

      <div className="split-ratio-preview">
        <span className="split-ratio-branch">
          <strong>a</strong> {hasRatio ? `${ratio}%` : "—"}
        </span>
        <span className="split-ratio-branch">
          <strong>b</strong> {hasRatio ? `${100 - ratio}%` : "—"}
        </span>
      </div>

      {!hasRatio ? (
        <p className="error">
          No ratio set yet — leads reaching this node are parked rather than sent down a guessed branch. Set one above.
        </p>
      ) : (
        <p className="muted">
          Connect this node's “a” and “b” handles to the two variants — an edge drawn from a handle carries that
          handle's name as its branch.
        </p>
      )}
    </div>
  );
}

// goal node: the activity threshold evaluateGoal() in lib/campaignEngine.js
// reads - { metric: "count" | "correct" | "graded", threshold: Number,
// outcome?: String }. Everything counted is activity *since the last send to
// this lead*, which is what makes the answer attributable to this drip rather
// than to whatever the lead was doing anyway.
//
// Shares ACTIVITY_METRICS with the condition node's "activity" case: the two
// read the same rollup, so offering different metrics would let one answer a
// question the other cannot.
function GoalPanel({ node, onChangeConfig }) {
  const config = node.config || {};
  const metric = config.metric || "count";
  // The walker accepts `count` as an older spelling of `threshold`; show
  // whichever is set, and write `threshold` from here on.
  const storedThreshold = config.threshold === undefined ? config.count : config.threshold;
  const threshold = storedThreshold === undefined || storedThreshold === null ? "" : storedThreshold;

  function set(patch) {
    onChangeConfig({ ...config, ...patch });
  }

  // Cleared means "unset", not zero: a stored 0 would be a threshold every lead
  // clears, sending everyone down "yes". Left unset, the handler's own default
  // of 1 applies.
  function setThreshold(raw) {
    set({ threshold: raw === "" ? undefined : Number(raw) });
  }

  return (
    <div>
      <p className="muted">
        Leads who cleared the threshold take the “yes” branch; everyone else takes “no”. Only activity recorded{" "}
        <em>after the last message this campaign sent them</em> counts.
      </p>

      <label className="form-row">
        Measure
        <select value={metric} onChange={(e) => set({ metric: e.target.value })}>
          {ACTIVITY_METRICS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label} — {m.hint}
            </option>
          ))}
        </select>
      </label>

      <label className="form-row">
        At least
        <input
          type="number"
          min="1"
          value={threshold}
          placeholder="1"
          onChange={(e) => setThreshold(e.target.value)}
        />
      </label>

      <label className="form-row">
        Outcome when met
        <input
          value={config.outcome || ""}
          placeholder="goal_met"
          onChange={(e) => set({ outcome: e.target.value })}
        />
        <span className="muted">
          Recorded as the enrollment's outcome if the “yes” branch ends without an exit node labelling it itself.
        </span>
      </label>

      <p className="muted">
        Needs a connected data source with an activity config (Data Sources tab). Without one this node can't answer its
        own question, so leads reaching it are parked rather than routed down “no”.
      </p>
    </div>
  );
}

// action node: the only kind that writes. Two shapes, told apart by
// `config.mode` (see actionModeFor() in lib/campaignEngine.js):
//
//   { mode: "http",   url, method, body, enabled, timeoutMs? }
//   { mode: "source", field, value, enabled, timeoutMs? }
//
// Both are gated twice at walk time — by the site-wide send kill switch first,
// then by this node's own `enabled` — and both are surfaced here rather than
// buried, because enabling one of these makes a real external side effect fire.
const HTTP_METHODS = ["POST", "PUT", "PATCH", "GET", "DELETE"];

function ActionPanel({ node, onChangeConfig, canonicalKeySuggestions }) {
  const config = node.config || {};
  const mode = config.mode === "source" ? "source" : "http";
  const enabled = config.enabled === true;

  // The body is stored as whatever it parses to: an object when the admin types
  // JSON (each value then interpolated field by field and re-serialized, so a
  // lead's name can't break the quoting), and the raw string otherwise. The
  // text being edited is local so a half-typed object isn't thrown away between
  // keystrokes.
  const [bodyText, setBodyText] = useState(() => {
    if (config.body === undefined || config.body === null) return "";
    return typeof config.body === "string" ? config.body : JSON.stringify(config.body, null, 2);
  });
  const bodyIsJson = (() => {
    if (!bodyText.trim()) return null;
    try {
      const parsed = JSON.parse(bodyText);
      return parsed && typeof parsed === "object";
    } catch {
      return false;
    }
  })();

  function set(patch) {
    onChangeConfig({ ...config, ...patch });
  }

  function setBody(text) {
    setBodyText(text);
    if (!text.trim()) return set({ body: undefined });
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") return set({ body: parsed });
    } catch {
      /* not JSON — stored verbatim below */
    }
    set({ body: text });
  }

  function setMode(next) {
    // Only the discriminator changes; the other mode's keys are left in place
    // so toggling back doesn't lose a URL that was already typed. The walker
    // dispatches on `mode` alone once it is set, so the unused keys are inert.
    set({ mode: next });
  }

  const keysHint = canonicalKeySuggestions.map((k) => `{{${k}}}`).join(", ");

  return (
    <div>
      <div className={`action-gate ${enabled ? "action-gate-on" : "action-gate-off"}`}>
        <label className="checkbox-row">
          <input type="checkbox" checked={enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          <strong>{enabled ? "Enabled — this node will fire" : "Disabled — this node will not fire"}</strong>
        </label>
        <p className="muted">
          Action nodes are the only kind that write to the world, so a new one starts <strong>disabled</strong> and stays
          that way until switched on here. A lead reaching a disabled action node is parked, not walked past.
        </p>
        <p className="action-gate-killswitch">
          Also gated by the site-wide send kill switch: with sending off, an enabled action node still does not fire.
          Turning this on is not enough on its own.
        </p>
      </div>

      <div className="form-row">
        <span>Mode</span>
        <div className="value-chip-row">
          <label className="checkbox-row">
            <input type="radio" name={`action-mode-${node.id}`} checked={mode === "http"} onChange={() => setMode("http")} />
            HTTP call
          </label>
          <label className="checkbox-row">
            <input
              type="radio"
              name={`action-mode-${node.id}`}
              checked={mode === "source"}
              onChange={() => setMode("source")}
            />
            Write back to source
          </label>
        </div>
      </div>

      {mode === "http" ? (
        <>
          <label className="form-row">
            URL
            <input
              value={config.url || ""}
              placeholder="https://example.com/hooks/lead"
              onChange={(e) => set({ url: e.target.value })}
            />
          </label>
          <label className="form-row">
            Method
            <select value={config.method || "POST"} onChange={(e) => set({ method: e.target.value })}>
              {HTTP_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="form-row">
            Body
            <textarea
              rows="5"
              className="action-body"
              value={bodyText}
              placeholder={'{ "phone": "{{phone}}", "name": "{{name}}" }'}
              onChange={(e) => setBody(e.target.value)}
            />
            <span className="muted">
              {bodyIsJson === null
                ? "Empty — no body is sent. GET and HEAD never send one."
                : bodyIsJson
                  ? "Valid JSON — sent as an object, each value interpolated separately."
                  : "Not JSON — sent verbatim as the request body."}
            </span>
          </label>
          {!config.url && <p className="error">No URL set — a lead reaching this node would fail rather than continue.</p>}
        </>
      ) : (
        <>
          <label className="form-row">
            Source field
            <input
              value={config.field || ""}
              placeholder="e.g. nurtureStage"
              onChange={(e) => set({ field: e.target.value })}
            />
            <span className="muted">
              The raw field name on the source's own documents — not a canonical key. This writes into the lead magnet's
              collection, so it has to use that collection's own column name.
            </span>
          </label>
          <label className="form-row">
            Value
            <input
              value={config.value === undefined ? "" : config.value}
              placeholder="e.g. contacted"
              onChange={(e) => set({ value: e.target.value })}
            />
          </label>
          {!config.field && (
            <p className="error">No field named — a lead reaching this node would fail rather than continue.</p>
          )}
        </>
      )}

      <label className="form-row">
        Timeout (ms)
        <input
          type="number"
          min="1"
          value={config.timeoutMs === undefined ? "" : config.timeoutMs}
          placeholder="10000"
          onChange={(e) => set({ timeoutMs: e.target.value === "" ? undefined : Number(e.target.value) })}
        />
      </label>

      <p className="muted">
        Interpolates the lead's canonical keys into the URL, body and value: {keysHint}.
      </p>
    </div>
  );
}

// exit node: a labelled outcome for the walk ending here.
function ExitPanel({ node, onChangeConfig }) {
  const config = node.config || {};
  return (
    <label className="form-row">
      Outcome
      <input
        value={config.outcome || ""}
        onChange={(e) => onChangeConfig({ ...config, outcome: e.target.value })}
        placeholder="e.g. completed, opted-out, converted"
      />
    </label>
  );
}

function UnsupportedPanel({ kind }) {
  return <p className="muted">Configuration for "{kind}" nodes isn't available on this canvas yet.</p>;
}

// Every kind in the schema's node-kind enum now has a form. split/goal/action
// were the three left out when the canvas was first built, because their walker
// handlers didn't exist yet; they do now, and each panel above emits exactly the
// config keys its handler reads.
const IN_SCOPE_KINDS = ["source", "filter", "message", "wait", "condition", "split", "goal", "action", "exit"];

// The side panel FlowCanvas renders for whichever node is selected,
// dispatching on the node's kind.
export default function NodeConfigPanel({
  node,
  sources,
  // Every `message` node in the graph, as { id, label } - what a condition
  // node's engagement case picks from. Narrower than the whole node list on
  // purpose: it is the only cross-node reference any panel makes.
  messageNodes = [],
  defaultFilterSource,
  canonicalKeySuggestions,
  onChangeLabel,
  onChangeConfig,
  onSaveAsPreset,
  savingPreset,
  onDelete,
  onClose,
}) {
  if (!node) return null;

  return (
    <div className="flow-config-panel">
      <div className="step-card-head">
        <strong className="flow-config-panel-kind">{node.kind}</strong>
        <div>
          {/* Saves this node's kind and config to the preset library — never
              its id or position, which mean nothing off this canvas. The saved
              copy is independent from this moment on: editing the preset later
              does not touch this node, and editing this node does not touch the
              preset. */}
          {onSaveAsPreset && (
            <button type="button" className="link-btn" onClick={onSaveAsPreset} disabled={savingPreset}>
              {savingPreset ? "saving…" : "save as preset"}
            </button>
          )}
          <button type="button" className="link-btn danger" onClick={onDelete}>
            delete
          </button>
          <button type="button" className="link-btn" onClick={onClose}>
            close
          </button>
        </div>
      </div>

      <label className="form-row">
        Label
        <input value={node.label || ""} onChange={(e) => onChangeLabel(e.target.value)} placeholder={`(unnamed ${node.kind})`} />
      </label>

      {node.kind === "source" && <SourcePanel node={node} sources={sources} onChangeConfig={onChangeConfig} />}
      {node.kind === "filter" && <FilterPanel node={node} defaultFilterSource={defaultFilterSource} onChangeConfig={onChangeConfig} />}
      {node.kind === "message" && (
        <MessagePanel node={node} onChangeConfig={onChangeConfig} canonicalKeySuggestions={canonicalKeySuggestions} />
      )}
      {node.kind === "wait" && <WaitPanel node={node} onChangeConfig={onChangeConfig} />}
      {node.kind === "condition" && (
        <ConditionPanel
          node={node}
          messageNodes={messageNodes}
          defaultFilterSource={defaultFilterSource}
          onChangeConfig={onChangeConfig}
        />
      )}
      {node.kind === "split" && <SplitPanel node={node} onChangeConfig={onChangeConfig} />}
      {node.kind === "goal" && <GoalPanel node={node} onChangeConfig={onChangeConfig} />}
      {node.kind === "action" && (
        <ActionPanel node={node} onChangeConfig={onChangeConfig} canonicalKeySuggestions={canonicalKeySuggestions} />
      )}
      {node.kind === "exit" && <ExitPanel node={node} onChangeConfig={onChangeConfig} />}
      {!IN_SCOPE_KINDS.includes(node.kind) && <UnsupportedPanel kind={node.kind} />}
    </div>
  );
}
