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
import { updateCampaign, publishCampaign } from "./api";

// The node kinds this task is responsible for. split/goal/action stay out of
// the palette entirely (task 14's scope) - a graph loaded from an older draft
// can still contain them (rendered generically, see FlowNode/UnsupportedPanel
// in NodeConfigPanel.jsx), they're just not something this canvas can create.
const PALETTE = [
  { kind: "source", label: "Source", hint: "Where leads enter this branch of the graph" },
  { kind: "filter", label: "Filter", hint: "Narrow who continues past this point" },
  { kind: "message", label: "Message", hint: "Send a WhatsApp template" },
  { kind: "wait", label: "Wait", hint: "Delay before the next step" },
  { kind: "condition", label: "Condition", hint: "Branch on yes/no" },
  { kind: "exit", label: "Exit", hint: "End the walk with an outcome" },
];

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
  return null;
}

function isSourceInvalid(kind, config) {
  return kind === "source" && !((config || {}).map && (config || {}).map.phone);
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
    <div className={`flow-node flow-node-${data.kind}${data.invalid ? " flow-node-invalid" : ""}`}>
      <Handle type="target" position={Position.Top} className="flow-handle flow-handle-in" />
      <div className="flow-node-kind">{data.kind}</div>
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

function PaletteItem({ kind, label, hint }) {
  function onDragStart(e) {
    e.dataTransfer.setData("application/flow-node-kind", kind);
    e.dataTransfer.effectAllowed = "move";
  }
  return (
    <div className="flow-palette-item" draggable onDragStart={onDragStart} title={hint}>
      <span className={`flow-palette-dot flow-palette-dot-${kind}`} />
      {label}
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
  const { screenToFlowPosition } = useReactFlow();
  const wrapperRef = useRef(null);

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

  const onDrop = useCallback(
    (event) => {
      event.preventDefault();
      const kind = event.dataTransfer.getData("application/flow-node-kind");
      if (!kind) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const id = nextId(kind);
      setNodes((nds) => nds.concat(toRFNode({ id, kind, label: "", position, config: {} })));
      setSelectedId(id);
    },
    [screenToFlowPosition, setNodes]
  );

  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
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
