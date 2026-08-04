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

// condition node: in-scope case only ("field") - the same filter shape as a
// filter node, evaluated by the walker to pick the yes/no branch.
function ConditionPanel({ node, defaultFilterSource, onChangeConfig }) {
  const config = node.config || {};
  function setFilter(filter) {
    onChangeConfig({ ...config, on: "field", filter });
  }
  return (
    <div>
      <p className="muted">Leads matching this filter take the "yes" branch; everyone else takes "no".</p>
      <FilterEditor key={node.id} source={defaultFilterSource} filter={config.filter} onChange={setFilter} />
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

const IN_SCOPE_KINDS = ["source", "filter", "message", "wait", "condition", "exit"];

// The side panel FlowCanvas renders for whichever node is selected,
// dispatching on the node's kind. split/goal/action are out of this task's
// scope (task 14) and fall through to a placeholder rather than a form.
export default function NodeConfigPanel({
  node,
  sources,
  defaultFilterSource,
  canonicalKeySuggestions,
  onChangeLabel,
  onChangeConfig,
  onDelete,
  onClose,
}) {
  if (!node) return null;

  return (
    <div className="flow-config-panel">
      <div className="step-card-head">
        <strong className="flow-config-panel-kind">{node.kind}</strong>
        <div>
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
        <ConditionPanel node={node} defaultFilterSource={defaultFilterSource} onChangeConfig={onChangeConfig} />
      )}
      {node.kind === "exit" && <ExitPanel node={node} onChangeConfig={onChangeConfig} />}
      {!IN_SCOPE_KINDS.includes(node.kind) && <UnsupportedPanel kind={node.kind} />}
    </div>
  );
}
