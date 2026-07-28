const express = require("express");
const { asyncRouter } = require("../lib/asyncRouter");
const {
  listLeadMagnets,
  createLeadMagnet,
  updateLeadMagnetLabel,
  addField,
  removeField,
  deleteLeadMagnet,
} = require("../lib/leadMagnets");

const router = asyncRouter();

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function page(body, flash) {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lead Magnets — Admin</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config = { darkMode: 'class' }</script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen p-6">
  <div class="max-w-3xl mx-auto space-y-6">
    <h1 class="text-2xl font-semibold">Lead Magnets</h1>
    <p class="text-slate-400 text-sm">
      Configure each lead magnet's fields here — one time, no redeploy. Changes
      apply immediately to <code class="text-slate-300">/api/leads/&lt;key&gt;</code>.
    </p>
    ${flash ? `<div class="rounded-md bg-slate-800 border border-slate-700 px-4 py-2 text-sm">${esc(flash)}</div>` : ""}
    ${body}
  </div>
</body>
</html>`;
}

function fieldRow(magnetKey, field) {
  return `<li class="flex items-center justify-between rounded bg-slate-900 border border-slate-800 px-3 py-2 text-sm">
    <span>
      <span class="font-mono">${esc(field.name)}</span>
      <span class="text-slate-500 ml-2">${esc(field.type)}</span>
      ${field.required ? '<span class="ml-2 text-amber-400">required</span>' : ""}
    </span>
    <form method="post" action="/admin/lead-magnets/${encodeURIComponent(magnetKey)}/fields/${encodeURIComponent(field.name)}/delete">
      <button class="text-red-400 hover:text-red-300 text-xs">remove</button>
    </form>
  </li>`;
}

function magnetCard(magnet) {
  return `<div class="rounded-lg border border-slate-800 bg-slate-900/50 p-4 space-y-3">
    <div class="flex items-center justify-between">
      <div>
        <div class="font-medium">${esc(magnet.label)}</div>
        <div class="text-xs text-slate-500 font-mono">${esc(magnet.key)}</div>
      </div>
      <form method="post" action="/admin/lead-magnets/${encodeURIComponent(magnet.key)}/delete"
            onsubmit="return confirm('Delete lead magnet ${esc(magnet.key)}? Existing leads keep their data but new submissions will be rejected.');">
        <button class="text-red-400 hover:text-red-300 text-xs">delete magnet</button>
      </form>
    </div>

    <ul class="space-y-1">
      ${magnet.fields.length ? magnet.fields.map((f) => fieldRow(magnet.key, f)).join("") : '<li class="text-slate-500 text-sm">No extra fields — only name/phone/email are collected.</li>'}
    </ul>

    <form method="post" action="/admin/lead-magnets/${encodeURIComponent(magnet.key)}/fields"
          class="flex flex-wrap gap-2 items-center pt-2 border-t border-slate-800">
      <input name="name" placeholder="field name" required
             class="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm w-40" />
      <select name="type" class="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm">
        <option value="string">string</option>
        <option value="number">number</option>
        <option value="boolean">boolean</option>
        <option value="date">date</option>
      </select>
      <label class="text-xs text-slate-400 flex items-center gap-1">
        <input type="checkbox" name="required" value="true" /> required
      </label>
      <button class="bg-emerald-700 hover:bg-emerald-600 rounded px-3 py-1 text-sm">add field</button>
    </form>
  </div>`;
}

router.get("/lead-magnets", async (req, res) => {
  const magnets = listLeadMagnets();
  const body = `
    <div class="space-y-4">
      ${magnets.length ? magnets.map(magnetCard).join("") : '<p class="text-slate-500">No lead magnets configured yet.</p>'}
    </div>

    <div class="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
      <div class="font-medium mb-2">Add a new lead magnet</div>
      <form method="post" action="/admin/lead-magnets" class="flex flex-wrap gap-2">
        <input name="key" placeholder="key (e.g. free-trial)" required
               class="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm w-48" />
        <input name="label" placeholder="display label"
               class="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm w-56" />
        <button class="bg-indigo-700 hover:bg-indigo-600 rounded px-3 py-1 text-sm">create</button>
      </form>
    </div>
  `;
  res.send(page(body, req.query.flash));
});

router.post("/lead-magnets", async (req, res, next) => {
  try {
    await createLeadMagnet({ key: req.body.key, label: req.body.label });
    res.redirect("/admin/lead-magnets?flash=" + encodeURIComponent(`Created "${req.body.key}"`));
  } catch (err) {
    next(err);
  }
});

router.post("/lead-magnets/:key/label", async (req, res, next) => {
  try {
    await updateLeadMagnetLabel(req.params.key, req.body.label);
    res.redirect("/admin/lead-magnets");
  } catch (err) {
    next(err);
  }
});

router.post("/lead-magnets/:key/fields", async (req, res, next) => {
  try {
    await addField(req.params.key, {
      name: req.body.name,
      type: req.body.type || "string",
      required: req.body.required === "true",
    });
    res.redirect("/admin/lead-magnets?flash=" + encodeURIComponent(`Added field "${req.body.name}" to "${req.params.key}"`));
  } catch (err) {
    next(err);
  }
});

router.post("/lead-magnets/:key/fields/:fieldName/delete", async (req, res, next) => {
  try {
    await removeField(req.params.key, req.params.fieldName);
    res.redirect("/admin/lead-magnets");
  } catch (err) {
    next(err);
  }
});

router.post("/lead-magnets/:key/delete", async (req, res, next) => {
  try {
    await deleteLeadMagnet(req.params.key);
    res.redirect("/admin/lead-magnets?flash=" + encodeURIComponent(`Deleted "${req.params.key}"`));
  } catch (err) {
    next(err);
  }
});

router.use((err, req, res, _next) => {
  res.status(err.status || 500).send(
    page(`<div class="rounded-md bg-red-950 border border-red-800 px-4 py-2 text-sm text-red-300">${esc(err.message)}</div>
          <a href="/admin/lead-magnets" class="text-sm text-slate-400 underline">back</a>`)
  );
});

module.exports = router;
