// End-to-end check of the webhook -> MessageEvent -> campaign-linkage chain.
// Replays the exact event sequence WATI sent for a real conversation (captured
// from the ngrok inspector), against a throwaway campaign + enrollment.
const m = require("mongoose");

const URI = "mongodb://127.0.0.1:27017/wati_cleanup";
const BASE = "http://127.0.0.1:3000";
const PHONE = "919000000001";
const W1 = "wamid.TEST.SEND.0001"; // wamid of the message we send
const L1 = "local-guid-0001"; // WATI's own id for the same message
const W2 = "wamid.TEST.INBOUND.0002"; // wamid of the lead's reply
const W3 = "wamid.TEST.INBOUND.0003"; // second inbound reply, used to probe opportunistic payload-id capture

const NODE_ID = "verify_msg_node"; // the graph node id this fixture's one message step stands in for

// The webhook now requires the shared secret (routes/wati.js, task 1) on every
// call. Read whatever's on the live active integration rather than faking one
// up — SECRET is filled in by the IIFE below before the first post() call.
let SECRET = "";

const post = async (body) => {
  const res = await fetch(`${BASE}/api/wati/webhook?secret=${encodeURIComponent(SECRET)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.status;
};

const chan = { channelId: "69dcd43ea259cd402640c030", channelPhoneNumber: "918946089717" };

// The nine events, in the order WATI actually delivered them.
const SEQUENCE = [
  { eventType: "templateMessageSent", waId: PHONE, whatsappMessageId: W1, statusString: "SENT", owner: true, text: "Hi there", ...chan },
  { eventType: "templateMessageSent_v2", waId: PHONE, whatsappMessageId: W1, localMessageId: L1, statusString: "SENT", owner: true, text: "Hi there", ...chan },
  { eventType: "sentMessageDELIVERED", whatsappMessageId: W1, statusString: "Delivered", ...chan },
  { eventType: "sentMessageDELIVERED_v2", whatsappMessageId: W1, localMessageId: L1, statusString: "Delivered", ...chan },
  { eventType: "sentMessageREAD", whatsappMessageId: W1, statusString: "Read", ...chan },
  { eventType: "sentMessageREAD_v2", whatsappMessageId: W1, localMessageId: L1, statusString: "Read", ...chan },
  { eventType: "message", waId: PHONE, whatsappMessageId: W2, replyContextId: W1, owner: false, statusString: "SENT", text: "Final Session", type: "button", ...chan },
  { eventType: "sentMessageREPLIED", whatsappMessageId: W1, statusString: "Replied", ...chan },
  { eventType: "sentMessageREPLIED_v2", whatsappMessageId: W1, localMessageId: L1, statusString: "Replied", ...chan },
];

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

(async () => {
  await m.connect(URI);
  const db = m.connection.db;
  const campaigns = db.collection("campaigns");
  const enrollments = db.collection("campaignenrollments");
  const events = db.collection("messageevents");
  const integrations = db.collection("whatsappintegrations");

  const activeIntegration = await integrations.findOne({ active: true });
  if (!activeIntegration?.webhookSecret) {
    console.error("No active WhatsAppIntegration with a webhookSecret found — connect one first (Integrations tab).");
    await m.disconnect();
    process.exit(1);
    return;
  }
  SECRET = activeIntegration.webhookSecret;

  // Clean slate for this phone / test campaign.
  await events.deleteMany({ phone: PHONE });
  await events.deleteMany({ providerMessageId: { $in: [W1, W2, W3, L1] } });
  await enrollments.deleteMany({ phone: PHONE });
  await campaigns.deleteMany({ name: "__verify_delivery__" });

  const campaign = await campaigns.insertOne({
    name: "__verify_delivery__",
    targetModel: "Contact",
    steps: [{ templateId: "verify_tpl", delayHours: 0 }],
    active: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // An enrollment whose send recorded NO provider id — the common case, since
  // WATI's send response often echoes nothing usable. Backfill has to fix it.
  const enrollment = await enrollments.insertOne({
    campaign: campaign.insertedId,
    targetModel: "Contact",
    targetId: new m.Types.ObjectId(),
    phone: PHONE,
    status: "completed",
    currentNodeId: NODE_ID,
    graphVersion: 1,
    nextSendAt: new Date(),
    history: [{ nodeId: NODE_ID, templateId: "verify_tpl", sentAt: new Date(), status: "sent" }],
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  for (const evt of SEQUENCE) {
    const status = await post(evt);
    if (status !== 200) check(`webhook accepted ${evt.eventType}`, false, `HTTP ${status}`);
  }
  await new Promise((r) => setTimeout(r, 600));

  // --- assertions ------------------------------------------------------
  const enr = await enrollments.findOne({ _id: enrollment.insertedId });
  check(
    "send event backfills wamid onto enrollment history",
    enr.history[0].providerMessageId === W1,
    `got ${enr.history[0].providerMessageId}`
  );
  check(
    "send event backfills WATI local id too",
    enr.history[0].providerLocalMessageId === L1,
    `got ${enr.history[0].providerLocalMessageId}`
  );

  const rows = await events.find({ $or: [{ phone: PHONE }, { providerMessageId: { $in: [W1, W2] } }] }).toArray();
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

  check("_v2 duplicate pairs collapse to one 'sent'", byStatus.sent === 1, `sent=${byStatus.sent}`);
  check("delivered stored exactly once", byStatus.delivered === 1, `delivered=${byStatus.delivered}`);
  check("read stored exactly once", byStatus.read === 1, `read=${byStatus.read}`);
  check("replied stored exactly once", byStatus.replied === 1, `replied=${byStatus.replied}`);
  check("inbound reply normalized to 'received', not 'sent'", byStatus.received === 1, `received=${byStatus.received}`);

  const linked = rows.filter((r) => String(r.enrollment) === String(enrollment.insertedId));
  check("every event links to the enrollment", linked.length === rows.length, `${linked.length}/${rows.length} linked`);
  check(
    "every event links to the campaign",
    rows.every((r) => String(r.campaign) === String(campaign.insertedId)),
    `${rows.filter((r) => r.campaign).length}/${rows.length}`
  );

  const noPhone = rows.filter((r) => r.phone === "unknown");
  check("status events inherit phone from enrollment", noPhone.length === 0, `${noPhone.length} rows still "unknown"`);

  // --- reply-context id + interactive type capture (task 3) ------------
  // W2 is the one realistic captured fixture in this repo: an inbound button
  // tap that carries replyContextId + type, but no separate payload id.
  const w2Row = rows.find((r) => r.providerMessageId === W2);
  check(
    "realistic button reply persists inReplyToProviderMessageId (the wamid it answers)",
    w2Row?.inReplyToProviderMessageId === W1,
    `got ${w2Row?.inReplyToProviderMessageId}`
  );
  check(
    "realistic button reply persists interactiveType 'button'",
    w2Row?.interactiveType === "button",
    `got ${w2Row?.interactiveType}`
  );
  check(
    "realistic button reply's missing payload id writes fine with no interactivePayloadId set",
    w2Row?.interactivePayloadId === undefined,
    `got ${JSON.stringify(w2Row?.interactivePayloadId)}`
  );

  // --- the API the UI actually calls -----------------------------------
  const funnel = await (await fetch(`${BASE}/api/campaigns/${campaign.insertedId}/delivery`)).json();
  check("funnel reports 1 delivered lead", funnel.counts.delivered.leads === 1, JSON.stringify(funnel.counts.delivered));
  check("funnel reports 1 read lead", funnel.counts.read.leads === 1, JSON.stringify(funnel.counts.read));
  check("funnel reports 1 replied lead", funnel.counts.replied.leads === 1, JSON.stringify(funnel.counts.replied));
  check("funnel denominator counts attempted sends", funnel.attempted === 1, `attempted=${funnel.attempted}`);

  const timeline = await (await fetch(`${BASE}/api/enrollments/${enrollment.insertedId}/events`)).json();
  check("timeline returns the lead's events oldest-first", timeline.count === rows.length, `${timeline.count} events`);
  check(
    "timeline carries the reply text",
    timeline.events.some((e) => e.text === "Final Session"),
    ""
  );

  const list = await (await fetch(`${BASE}/api/campaigns/${campaign.insertedId}/enrollments`)).json();
  check(
    "enrollments listing carries per-lead delivery rollup",
    Boolean(list.enrollments[0]?.delivery?.read),
    JSON.stringify(list.enrollments[0]?.delivery || {})
  );

  // --- opportunistic button payload-id capture (task 3) -----------------
  // W3 is NOT a captured fixture — the `button.payload` shape is a guess at
  // one of several plausible field names (see extractInteractivePayloadId()
  // in routes/wati.js). Posted after the funnel/timeline/list checks above
  // so it doesn't shift those counts; this only proves the opportunistic-
  // capture plumbing works when a recognized field name IS present, and says
  // nothing about what WATI actually sends, which is still unconfirmed.
  await post({
    eventType: "message",
    waId: PHONE,
    whatsappMessageId: W3,
    replyContextId: W1,
    owner: false,
    statusString: "SENT",
    text: "Session A",
    type: "button",
    button: { payload: "OPT_A" },
    ...chan,
  });
  await new Promise((r) => setTimeout(r, 300));
  const w3Row = await events.findOne({ providerMessageId: W3 });
  check(
    "opportunistic payload id captured when present under a recognized field name",
    w3Row?.interactivePayloadId === "OPT_A",
    `got ${w3Row?.interactivePayloadId}`
  );
  check(
    "opportunistically-captured event still carries inReplyToProviderMessageId + interactiveType",
    w3Row?.inReplyToProviderMessageId === W1 && w3Row?.interactiveType === "button",
    `got inReplyTo=${w3Row?.inReplyToProviderMessageId} type=${w3Row?.interactiveType}`
  );

  // Cleanup.
  await events.deleteMany({ $or: [{ phone: PHONE }, { providerMessageId: { $in: [W1, W2, W3] } }] });
  await enrollments.deleteMany({ phone: PHONE });
  await campaigns.deleteMany({ name: "__verify_delivery__" });

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await m.disconnect();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
