// End-to-end check of the manual single-send tracking chain:
// DirectMessage -> webhook -> MessageEvent linkage -> the APIs the UI calls.
//
// Companion to verify-webhook.js, which covers the campaign path. Replays the
// same real WATI event sequence, but against a hand-sent message that belongs
// to no campaign — the case that used to be stored unattributed.
const m = require("mongoose");

const URI = "mongodb://127.0.0.1:27017/wati_cleanup";
const BASE = "http://127.0.0.1:3000";

const PHONE = "919000000002"; // the hand-sent message
const W1 = "wamid.TEST.DIRECT.0001";
const L1 = "local-guid-direct-0001";
const W2 = "wamid.TEST.DIRECT.INBOUND.0002"; // the lead's reply

// A second number that has BOTH a campaign enrollment and a manual send, used
// to prove an exact id match on the enrollment still wins.
const PHONE2 = "919000000003";
const W3 = "wamid.TEST.BOTH.0003";

const post = async (body) => {
  const res = await fetch(`${BASE}/api/wati/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.status;
};

const chan = { channelId: "69dcd43ea259cd402640c030", channelPhoneNumber: "918946089717" };

// The nine events, in the order WATI actually delivers them.
const SEQUENCE = [
  { eventType: "templateMessageSent", waId: PHONE, whatsappMessageId: W1, statusString: "SENT", owner: true, text: "Hi there", ...chan },
  { eventType: "templateMessageSent_v2", waId: PHONE, whatsappMessageId: W1, localMessageId: L1, statusString: "SENT", owner: true, text: "Hi there", ...chan },
  { eventType: "sentMessageDELIVERED", whatsappMessageId: W1, statusString: "Delivered", ...chan },
  { eventType: "sentMessageDELIVERED_v2", whatsappMessageId: W1, localMessageId: L1, statusString: "Delivered", ...chan },
  { eventType: "sentMessageREAD", whatsappMessageId: W1, statusString: "Read", ...chan },
  { eventType: "sentMessageREAD_v2", whatsappMessageId: W1, localMessageId: L1, statusString: "Read", ...chan },
  { eventType: "message", waId: PHONE, whatsappMessageId: W2, replyContextId: W1, owner: false, statusString: "SENT", text: "Yes please", type: "button", ...chan },
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
  const directs = db.collection("directmessages");
  const events = db.collection("messageevents");

  const wipe = async () => {
    await events.deleteMany({ $or: [{ phone: { $in: [PHONE, PHONE2] } }, { providerMessageId: { $in: [W1, W2, W3] } }] });
    await directs.deleteMany({ phone: { $in: [PHONE, PHONE2] } });
    await enrollments.deleteMany({ phone: { $in: [PHONE, PHONE2] } });
    await campaigns.deleteMany({ name: "__verify_direct__" });
  };
  await wipe();

  // A manual send that recorded NO provider id — the common case, since the
  // send response often echoes nothing usable. Backfill has to fix it.
  const direct = await directs.insertOne({
    phone: PHONE,
    templateId: "verify_direct_tpl",
    broadcastName: "verify_direct",
    status: "sent",
    sentAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  for (const evt of SEQUENCE) {
    const status = await post(evt);
    if (status !== 200) check(`webhook accepted ${evt.eventType}`, false, `HTTP ${status}`);
  }
  await new Promise((r) => setTimeout(r, 600));

  // --- backfill --------------------------------------------------------
  const dm = await directs.findOne({ _id: direct.insertedId });
  check("send event backfills wamid onto the direct message", dm.providerMessageId === W1, `got ${dm.providerMessageId}`);
  check("send event backfills WATI local id too", dm.providerLocalMessageId === L1, `got ${dm.providerLocalMessageId}`);

  // --- event storage ---------------------------------------------------
  const rows = await events.find({ $or: [{ phone: PHONE }, { providerMessageId: { $in: [W1, W2] } }] }).toArray();
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

  check("_v2 duplicate pairs collapse to one 'sent'", byStatus.sent === 1, `sent=${byStatus.sent}`);
  check("delivered stored exactly once", byStatus.delivered === 1, `delivered=${byStatus.delivered}`);
  check("read stored exactly once", byStatus.read === 1, `read=${byStatus.read}`);
  check("replied stored exactly once", byStatus.replied === 1, `replied=${byStatus.replied}`);
  check("inbound reply normalized to 'received'", byStatus.received === 1, `received=${byStatus.received}`);

  const linked = rows.filter((r) => String(r.directMessage) === String(direct.insertedId));
  check("every event links to the direct message", linked.length === rows.length, `${linked.length}/${rows.length} linked`);
  check(
    "no event is wrongly attributed to a campaign",
    rows.every((r) => !r.enrollment && !r.campaign),
    `${rows.filter((r) => r.enrollment || r.campaign).length} wrongly attributed`
  );
  check(
    "status events inherit phone from the direct message",
    rows.every((r) => r.phone !== "unknown"),
    `${rows.filter((r) => r.phone === "unknown").length} rows still "unknown"`
  );

  // --- an enrollment still wins when it owns the id --------------------
  const campaign = await campaigns.insertOne({
    name: "__verify_direct__",
    targetModel: "Contact",
    steps: [{ templateId: "verify_tpl", delayHours: 0 }],
    active: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const enrollment = await enrollments.insertOne({
    campaign: campaign.insertedId,
    targetModel: "Contact",
    targetId: new m.Types.ObjectId(),
    phone: PHONE2,
    status: "completed",
    currentStepIndex: 0,
    nextSendAt: new Date(),
    history: [{ stepIndex: 0, templateId: "verify_tpl", sentAt: new Date(), status: "sent", providerMessageId: W3 }],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  // Same number, hand-sent later — so the phone fallback would pick this one.
  // The exact id match on the enrollment must beat it.
  await directs.insertOne({
    phone: PHONE2,
    templateId: "verify_direct_tpl",
    status: "sent",
    sentAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await post({ eventType: "sentMessageDELIVERED", whatsappMessageId: W3, statusString: "Delivered", ...chan });
  await new Promise((r) => setTimeout(r, 400));

  const contested = await events.findOne({ providerMessageId: W3, status: "delivered" });
  check(
    "exact id match on an enrollment beats a newer manual send to the same number",
    String(contested?.enrollment) === String(enrollment.insertedId) && !contested?.directMessage,
    `enrollment=${contested?.enrollment} directMessage=${contested?.directMessage}`
  );

  // --- the APIs the UI actually calls ----------------------------------
  const list = await (await fetch(`${BASE}/api/direct-messages?phone=${PHONE}`)).json();
  const row = list.messages?.[0];
  check("listing returns the hand-sent message", String(row?._id) === String(direct.insertedId), `got ${row?._id}`);
  check("listing carries the delivery rollup", row?.delivery?.read === 1 && row?.delivery?.delivered === 1, JSON.stringify(row?.delivery || {}));

  const timeline = await (await fetch(`${BASE}/api/direct-messages/${direct.insertedId}/events`)).json();
  check("timeline returns the message's events", timeline.count === rows.length, `${timeline.count} events`);
  check("timeline carries the reply text", timeline.events?.some((e) => e.text === "Yes please"), "");

  const orphans = await (await fetch(`${BASE}/api/message-events?linked=no&phone=${PHONE}`)).json();
  check("a tracked manual send no longer counts as unattributed", orphans.total === 0, `${orphans.total} orphaned`);

  await wipe();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await m.disconnect();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
