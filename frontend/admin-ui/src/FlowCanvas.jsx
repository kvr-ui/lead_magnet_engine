import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import NodeConfigPanel from "./NodeConfigPanel";
import { describeFilter } from "./FilterBuilder";
import { updateCampaign, publishCampaign, fetchNodePresets, createNodePreset, updateNodePreset, deleteNodePreset } from "./api";

// Every node kind the schema defines. split/goal/action joined the palette once
// their walker handlers landed and their config panels were built.
const PALETTE = [
  { kind: "source", label: "Source", hint: "Where leads enter this branch of the graph" },
  { kind: "filter", label: "Filter", hint: "Narrow who continues past this point" },
  { kind: "message", label: "Message", hint: "Send a WhatsApp template" },
  { kind: "wait", label: "Wait", hint: "Delay before the next step" },
  { kind: "condition", label: "Condition", hint: "Branch on yes/no" },
  { kind: "split", label: "Split", hint: "Send a share of leads down a/b" },
  { kind: "goal", label: "Goal", hint: "Branch on whether the lead converted" },
  { kind: "action", label: "Action", hint: "Call an endpoint or write back to the source" },
  { kind: "exit", label: "Exit", hint: "End the walk with an outcome" },
];

// The config a freshly dropped node starts with. Only `action` needs one: it is
// the only kind that writes, and its walker handler parks any lead reaching it
// unless config.enabled === true. Writing the toggle out explicitly (rather
// than relying on the absence of the key) is what makes "disabled" something an
// admin can see in the panel and on the node the instant it is created, instead
// of an implication of an empty object.
function defaultConfigFor(kind) {
  if (kind === "action") return { mode: "http", method: "POST", enabled: false };
  return {};
}

// Kinds that render two labelled output handles instead of one unlabelled
// one, and the handle ids each emits - which double as the edge `branch`
// value an edge drawn from that handle carries (see onConnect below).
const TWO_HANDLE_KINDS = { condition: ["yes", "no"], goal: ["yes", "no"], split: ["a", "b"] };

let idSeq = 0;
function nextId(prefix) {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSeq}`;
}

// A human-readable subtitle under a node's label on the canvas. Source and
// filter nodes reuse describeFilter from FilterBuilder.jsx unchanged, per the
// task's "reuse, don't rebuild" rule.
function subtitleFor(kind, config) {
  const c = config || {};
  if ((kind === "source" || kind === "filter") && c.filter && Object.keys(c.filter).length) {
    return describeFilter(c.filter);
  }
  if (kind === "condition" && (c.on === "field" || !c.on) && c.filter && Object.keys(c.filter).length) {
    return describeFilter(c.filter);
  }
  if (kind === "message" && c.templateId) return c.templateId;
  if (kind === "wait" && c.amount) return `${c.amount} ${c.unit || ""}`.trim();
  if (kind === "exit" && c.outcome) return c.outcome;
  if (kind === "source" && c.sourceId) return c.sourceId;
  if (kind === "split") {
    const ratio = Number(c.ratio);
    return Number.isFinite(ratio) ? `${ratio}% a · ${100 - ratio}% b` : "no ratio set";
  }
  if (kind === "goal") {
    const threshold = c.threshold === undefined ? c.count : c.threshold;
    return `${c.metric || "count"} ≥ ${threshold === undefined || threshold === null || threshold === "" ? 1 : threshold}`;
  }
  if (kind === "action") {
    if (c.mode === "source" || (!c.mode && c.field)) return c.field ? `set ${c.field}` : "source write-back";
    return c.url ? `${c.method || "POST"} ${c.url}` : "HTTP call";
  }
  return null;
}

function isSourceInvalid(kind, config) {
  return kind === "source" && !((config || {}).map && (config || {}).map.phone);
}

// An action node that hasn't been switched on. Surfaced on the canvas itself,
// not only inside the inspector: an action is the one node kind with a real
// external side effect, so which of them are live has to be answerable at a
// glance across the whole graph rather than by opening each one in turn.
function isActionDisabled(kind, config) {
  return kind === "action" && (config || {}).enabled !== true;
}

// --- domain (campaign.draft) <-> @xyflow/react node/edge shape -------------

function toRFNode(n) {
  return {
    id: n.id,
    type: "flowNode",
    position: n.position || { x: 0, y: 0 },
    data: {
      kind: n.kind,
      label: n.label || "",
      config: n.config || {},
      subtitle: subtitleFor(n.kind, n.config),
      invalid: isSourceInvalid(n.kind, n.config),
      actionDisabled: isActionDisabled(n.kind, n.config),
    },
  };
}

function fromRFNode(n) {
  return { id: n.id, kind: n.data.kind, label: (n.data.label || "").trim(), position: n.position, config: n.data.config || {} };
}

function toRFEdge(e) {
  return {
    id: e.id,
    source: e.from,
    target: e.to,
    sourceHandle: e.branch || undefined,
    label: e.branch || undefined,
  };
}

function fromRFEdge(e) {
  return { id: e.id, from: e.source, to: e.target, ...(e.sourceHandle ? { branch: e.sourceHandle.trim() } : {}) };
}

function toDomainGraph(nodes, edges) {
  return { nodes: nodes.map(fromRFNode), edges: edges.map(fromRFEdge) };
}

// Order-independent equality of two graphs - used to tell whether the canvas
// currently differs from the last-published version.
function normalizeGraphForCompare(g) {
  const nodes = [...((g && g.nodes) || [])]
    .map((n) => ({ id: n.id, kind: n.kind, label: n.label || "", position: n.position || { x: 0, y: 0 }, config: n.config || {} }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...((g && g.edges) || [])]
    .map((e) => ({ id: e.id, from: e.from, to: e.to, branch: e.branch || null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ nodes, edges });
}

function graphsEqual(a, b) {
  return normalizeGraphForCompare(a) === normalizeGraphForCompare(b);
}

// --- canvas node rendering ---------------------------------------------

function FlowNode({ data }) {
  const branches = TWO_HANDLE_KINDS[data.kind];
  return (
    <div
      className={`flow-node flow-node-${data.kind}${data.invalid ? " flow-node-invalid" : ""}${
        data.actionDisabled ? " flow-node-action-off" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} className="flow-handle flow-handle-in" />
      <div className="flow-node-kind">
        {data.kind}
        {data.kind === "action" && (
          <span className={`flow-node-badge ${data.actionDisabled ? "flow-node-badge-off" : "flow-node-badge-on"}`}>
            {data.actionDisabled ? "disabled" : "live"}
          </span>
        )}
      </div>
      <div className="flow-node-label">{data.label || `(unnamed ${data.kind})`}</div>
      {data.subtitle && <div className="flow-node-subtitle">{data.subtitle}</div>}
      {data.invalid && <div className="flow-node-error">phone mapping required</div>}
      {branches ? (
        <div className="flow-node-branches">
          {branches.map((b) => (
            <span className="flow-node-branch-label" key={b}>
              {b}
            </span>
          ))}
          <Handle type="source" position={Position.Bottom} id={branches[0]} style={{ left: "30%" }} className="flow-handle flow-handle-out" />
          <Handle type="source" position={Position.Bottom} id={branches[1]} style={{ left: "70%" }} className="flow-handle flow-handle-out" />
        </div>
      ) : (
        <Handle type="source" position={Position.Bottom} className="flow-handle flow-handle-out" />
      )}
    </div>
  );
}

const NODE_TYPES = { flowNode: FlowNode };

// The two things that can be dragged onto the canvas: a blank node of some
// kind, and a saved preset. Distinct MIME types so a drop can tell them apart
// without inspecting the payload.
const KIND_MIME = "application/flow-node-kind";
const PRESET_MIME = "application/flow-node-preset-id";

function PaletteItem({ kind, label, hint }) {
  function onDragStart(e) {
    e.dataTransfer.setData(KIND_MIME, kind);
    e.dataTransfer.effectAllowed = "move";
  }
  return (
    <div className="flow-palette-item" draggable onDragStart={onDragStart} title={hint}>
      <span className={`flow-palette-dot flow-palette-dot-${kind}`} />
      {label}
    </div>
  );
}

// --- preset library -------------------------------------------------------

/**
 * A snapshot of a config, structurally detached from whatever it was read off.
 *
 * This is the whole preset mechanism in one function. A preset is inserted by
 * *copying* its config, so the node that lands on the canvas shares no object
 * with the preset document held in this component's state — editing the preset
 * afterwards cannot reach the node, and editing the node cannot reach the
 * preset. The alternative (storing a preset id on the node and resolving it at
 * walk time) would let a typo fix on a preset silently rewrite the flow under
 * every lead already walking it, which is exactly what the draft/publish split
 * exists to prevent. Nothing here writes a preset id onto a node.
 */
function deepCopyConfig(config) {
  return JSON.parse(JSON.stringify(config || {}));
}

function PresetItem({ preset, onRename, onDelete }) {
  function onDragStart(e) {
    e.dataTransfer.setData(PRESET_MIME, preset._id);
    e.dataTransfer.effectAllowed = "copy";
  }
  return (
    <div className="flow-preset-item" draggable onDragStart={onDragStart} title="Drag onto the canvas to insert a copy">
      <span className={`flow-palette-dot flow-palette-dot-${preset.kind}`} />
      <span className="flow-preset-name">{preset.name}</span>
      <button type="button" className="link-btn" onClick={() => onRename(preset)}>
        rename
      </button>
      <button type="button" className="link-btn danger" onClick={() => onDelete(preset)}>
        remove
      </button>
    </div>
  );
}

function PresetLibrary({ presets, loading, error, onRename, onDelete }) {
  const [open, setOpen] = useState(true);
  const [kindFilter, setKindFilter] = useState("");

  const kinds = useMemo(() => [...new Set(presets.map((p) => p.kind))].sort(), [presets]);
  const shown = useMemo(
    () => (kindFilter ? presets.filter((p) => p.kind === kindFilter) : presets),
    [presets, kindFilter]
  );
  // Grouped by kind, because that's how an admin looks for one: "which of my
  // saved message nodes do I want here", not "which of all my presets".
  const grouped = useMemo(() => {
    const out = new Map();
    for (const preset of shown) {
      if (!out.has(preset.kind)) out.set(preset.kind, []);
      out.get(preset.kind).push(preset);
    }
    return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [shown]);

  return (
    <div className="flow-preset-library">
      <button type="button" className="flow-preset-toggle" onClick={() => setOpen(!open)}>
        <span>Presets{presets.length ? ` (${presets.length})` : ""}</span>
        <span className="flow-preset-caret">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <>
          {error && <p className="error">{error}</p>}
          {kinds.length > 1 && (
            <select className="flow-preset-filter" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
              <option value="">All kinds</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          )}

          {grouped.map(([kind, items]) => (
            <div className="flow-preset-group" key={kind}>
              <h5 className="flow-preset-group-head">{kind}</h5>
              {items.map((preset) => (
                <PresetItem key={preset._id} preset={preset} onRename={onRename} onDelete={onDelete} />
              ))}
            </div>
          ))}

          {!loading && !presets.length && (
            <p className="muted flow-palette-hint">
              None yet — select a node and choose “save as preset” to reuse its configuration elsewhere.
            </p>
          )}
          {!loading && presets.length > 0 && !shown.length && (
            <p className="muted flow-palette-hint">No presets of that kind.</p>
          )}
          {open && presets.length > 0 && (
            <p className="muted flow-palette-hint">
              Dragging one in inserts a copy of its configuration. Editing the preset later leaves that copy alone.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// --- the canvas itself ---------------------------------------------------

function FlowCanvasInner({
  campaignId,
  initialNodes,
  initialEdges,
  liveVersion,
  publishedNodes,
  publishedEdges,
  sources,
  onGraphChange,
  onValidityChange,
  onSaved,
  onPublished,
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes.map(toRFNode));
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges.map(toRFEdge));
  const [selectedId, setSelectedId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState(null);
  const [localLiveVersion, setLocalLiveVersion] = useState(liveVersion ?? null);
  const [localPublished, setLocalPublished] = useState({ nodes: publishedNodes || [], edges: publishedEdges || [] });
  const [presets, setPresets] = useState([]);
  const [presetsLoading, setPresetsLoading] = useState(true);
  const [presetsError, setPresetsError] = useState(null);
  const [savingPreset, setSavingPreset] = useState(false);
  const { screenToFlowPosition } = useReactFlow();
  const wrapperRef = useRef(null);
  // Read inside onDrop, which is memoized on things that don't include the
  // preset list — a ref keeps the handler looking at the current library
  // without re-creating (and re-binding) it every time a preset is saved.
  const presetsRef = useRef(presets);
  presetsRef.current = presets;

  const invalidCount = useMemo(() => nodes.filter((n) => n.data.invalid).length, [nodes]);
  const canSave = invalidCount === 0;

  useEffect(() => {
    onValidityChange?.(canSave);
  }, [canSave, onValidityChange]);

  useEffect(() => {
    if (campaignId) return; // create-mode only: detail mode persists via Save/Publish below
    onGraphChange?.(toDomainGraph(nodes, edges));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, campaignId]);

  const dirty = useMemo(() => !graphsEqual(toDomainGraph(nodes, edges), localPublished), [nodes, edges, localPublished]);

  const onConnect = useCallback(
    (params) => {
      setEdges((eds) =>
        addEdge(
          { ...params, id: nextId("edge"), label: params.sourceHandle || undefined },
          eds
        )
      );
    },
    [setEdges]
  );

  const loadPresets = useCallback(() => {
    setPresetsLoading(true);
    return fetchNodePresets()
      .then((d) => {
        setPresets(d.presets || []);
        setPresetsError(null);
      })
      .catch((err) => setPresetsError(err.message))
      .finally(() => setPresetsLoading(false));
  }, []);

  useEffect(() => {
    loadPresets();
  }, [loadPresets]);

  const onDrop = useCallback(
    (event) => {
      event.preventDefault();
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });

      // A preset drop builds an ordinary node: a freshly generated id, the drop
      // position, the preset's kind, and a deep copy of its config. Nothing
      // about the preset itself — not its _id, not a reference to the document
      // — is carried onto the node, so what lands here is indistinguishable
      // from a node typed by hand, and stays that way however the preset is
      // edited afterwards.
      const presetId = event.dataTransfer.getData(PRESET_MIME);
      if (presetId) {
        const preset = presetsRef.current.find((p) => p._id === presetId);
        if (!preset) return;
        const id = nextId(preset.kind);
        setNodes((nds) =>
          nds.concat(
            toRFNode({ id, kind: preset.kind, label: preset.name || "", position, config: deepCopyConfig(preset.config) })
          )
        );
        setSelectedId(id);
        return;
      }

      const kind = event.dataTransfer.getData(KIND_MIME);
      if (!kind) return;
      const id = nextId(kind);
      setNodes((nds) => nds.concat(toRFNode({ id, kind, label: "", position, config: defaultConfigFor(kind) })));
      setSelectedId(id);
    },
    [screenToFlowPosition, setNodes]
  );

  // dropEffect has to be compatible with the effectAllowed the drag started
  // with or the browser cancels the drop outright — a preset drag is a copy
  // (the preset stays in the library), a palette drag is a move.
  const onDragOver = useCallback((event) => {
    event.preventDefault();
    const types = Array.from(event.dataTransfer.types || []);
    event.dataTransfer.dropEffect = types.includes(PRESET_MIME) ? "copy" : "move";
  }, []);

  const onNodeClick = useCallback((_event, node) => setSelectedId(node.id), []);
  const onPaneClick = useCallback(() => setSelectedId(null), []);

  const onNodesDelete = useCallback(
    (deleted) => {
      const ids = new Set(deleted.map((n) => n.id));
      setEdges((eds) => eds.filter((e) => !ids.has(e.source) && !ids.has(e.target)));
      setSelectedId((cur) => (cur && ids.has(cur) ? null : cur));
    },
    [setEdges]
  );

  function deleteNode(id) {
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
    setSelectedId(null);
  }

  const updateSelectedNode = useCallback(
    (patch) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== selectedId) return n;
          const label = patch.label !== undefined ? patch.label : n.data.label;
          const config = patch.config !== undefined ? patch.config : n.data.config;
          return {
            ...n,
            data: {
              ...n.data,
              label,
              config,
              subtitle: subtitleFor(n.data.kind, config),
              invalid: isSourceInvalid(n.data.kind, config),
              actionDisabled: isActionDisabled(n.data.kind, config),
            },
          };
        })
      );
    },
    [selectedId, setNodes]
  );

  const selectedDomainNode = useMemo(() => {
    const rf = nodes.find((n) => n.id === selectedId);
    return rf ? fromRFNode(rf) : null;
  }, [nodes, selectedId]);

  // Which source to browse fields against for a filter/condition node's field
  // picker, and which canonical keys to suggest for a message node's param
  // "from" - both read off whatever source node(s) already exist in the graph,
  // since that's the map a downstream node's canonical keys actually come from.
  const defaultFilterSource = useMemo(() => {
    const first = nodes.find((n) => n.data.kind === "source" && n.data.config?.sourceId);
    return (first && first.data.config.sourceId) || (sources[0] && sources[0].value) || "Contact";
  }, [nodes, sources]);

  const canonicalKeySuggestions = useMemo(() => {
    const keys = new Set(["phone", "name", "email"]);
    nodes.forEach((n) => {
      if (n.data.kind === "source") Object.keys(n.data.config?.map || {}).forEach((k) => keys.add(k));
    });
    return [...keys];
  }, [nodes]);

  // Saves the selected node's kind and config to the preset library. `id`,
  // `position` and the node's own label are per-instance and deliberately not
  // sent: a preset is a configuration, not a placed node.
  async function handleSaveAsPreset() {
    if (!selectedDomainNode) return;
    const suggested = selectedDomainNode.label || `${selectedDomainNode.kind} preset`;
    const name = window.prompt("Name this preset", suggested);
    if (name === null) return;
    if (!name.trim()) {
      setError("A preset needs a name.");
      return;
    }
    setError(null);
    setSavingPreset(true);
    try {
      await createNodePreset({
        name: name.trim(),
        kind: selectedDomainNode.kind,
        config: selectedDomainNode.config || {},
      });
      await loadPresets();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingPreset(false);
    }
  }

  // Renaming or deleting a preset touches the library and nothing else. Every
  // node already inserted from it keeps the configuration it was inserted with,
  // in this draft and in every published version.
  async function handleRenamePreset(preset) {
    const name = window.prompt(`Rename "${preset.name}"`, preset.name);
    if (name === null || !name.trim() || name.trim() === preset.name) return;
    try {
      await updateNodePreset(preset._id, { name: name.trim() });
      await loadPresets();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDeletePreset(preset) {
    if (!window.confirm(`Remove the preset "${preset.name}"? Nodes already inserted from it are unaffected.`)) return;
    try {
      await deleteNodePreset(preset._id);
      await loadPresets();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleSave() {
    if (!canSave) {
      setError("Every source node needs a phone mapping before this flow can be saved.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const graph = toDomainGraph(nodes, edges);
      const updated = await updateCampaign(campaignId, { draft: graph });
      onSaved?.(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handlePublish() {
    if (!canSave) {
      setError("Every source node needs a phone mapping before this flow can be published.");
      return;
    }
    setError(null);
    setPublishing(true);
    try {
      const graph = toDomainGraph(nodes, edges);
      await updateCampaign(campaignId, { draft: graph });
      const published = await publishCampaign(campaignId);
      setLocalLiveVersion(published.liveVersion);
      setLocalPublished({ nodes: published.nodes || [], edges: published.edges || [] });
      onPublished?.(published);
    } catch (err) {
      setError(err.message);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="flow-canvas">
      <div className="flow-canvas-toolbar">
        <div className="flow-canvas-toolbar-left">
          {campaignId && (
            <span className={`badge ${localLiveVersion ? "badge-info" : "badge-neutral"}`}>
              {localLiveVersion ? `Live v${localLiveVersion}` : "Never published"}
            </span>
          )}
          {campaignId && dirty && <span className="badge badge-warning">Unpublished changes</span>}
        </div>
        <div className="flow-canvas-toolbar-right">
          {error && <span className="error">{error}</span>}
          {campaignId ? (
            <>
              <button type="button" className="secondary-btn" onClick={handleSave} disabled={saving || publishing}>
                {saving ? "Saving…" : "Save draft"}
              </button>
              <button type="button" onClick={handlePublish} disabled={saving || publishing || !dirty}>
                {publishing ? "Publishing…" : "Publish"}
              </button>
            </>
          ) : (
            <span className="muted">Build the flow, then create the campaign to save it as a draft.</span>
          )}
        </div>
      </div>
      {!canSave && (
        <p className="error">
          {invalidCount} source node{invalidCount === 1 ? "" : "s"} still need{invalidCount === 1 ? "s" : ""} a phone
          mapping — open it from the canvas and set one before saving.
        </p>
      )}

      <div className="flow-canvas-grid">
        <div className="flow-palette">
          <h4>Add a node</h4>
          {PALETTE.map((p) => (
            <PaletteItem key={p.kind} {...p} />
          ))}
          <p className="muted flow-palette-hint">Drag onto the canvas.</p>

          <PresetLibrary
            presets={presets}
            loading={presetsLoading}
            error={presetsError}
            onRename={handleRenamePreset}
            onDelete={handleDeletePreset}
          />
        </div>

        <div className="flow-surface" ref={wrapperRef} onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onNodesDelete={onNodesDelete}
            deleteKeyCode={["Backspace", "Delete"]}
            fitView
          >
            <Background gap={18} />
            <Controls showInteractive={false} />
          </ReactFlow>
          {!nodes.length && <p className="flow-empty-hint muted">Drag a node from the palette to get started.</p>}
        </div>

        {selectedDomainNode ? (
          <NodeConfigPanel
            key={selectedDomainNode.id}
            node={selectedDomainNode}
            sources={sources}
            defaultFilterSource={defaultFilterSource}
            canonicalKeySuggestions={canonicalKeySuggestions}
            onChangeLabel={(label) => updateSelectedNode({ label })}
            onChangeConfig={(config) => updateSelectedNode({ config })}
            onSaveAsPreset={handleSaveAsPreset}
            savingPreset={savingPreset}
            onDelete={() => deleteNode(selectedDomainNode.id)}
            onClose={() => setSelectedId(null)}
          />
        ) : (
          <div className="flow-config-panel flow-config-panel-empty muted">Select a node to configure it.</div>
        )}
      </div>
    </div>
  );
}

// Public component: wraps the inner canvas in ReactFlowProvider, which
// useReactFlow() (needed to place a dropped node under the cursor) requires.
export default function FlowCanvas({
  campaignId = null,
  initialNodes = [],
  initialEdges = [],
  liveVersion = null,
  publishedNodes = [],
  publishedEdges = [],
  sources = [],
  onGraphChange,
  onValidityChange,
  onSaved,
  onPublished,
}) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner
        campaignId={campaignId}
        initialNodes={initialNodes}
        initialEdges={initialEdges}
        liveVersion={liveVersion}
        publishedNodes={publishedNodes}
        publishedEdges={publishedEdges}
        sources={sources}
        onGraphChange={onGraphChange}
        onValidityChange={onValidityChange}
        onSaved={onSaved}
        onPublished={onPublished}
      />
    </ReactFlowProvider>
  );
}
