const express = require("express");
const { getAdMagnetConnection } = require("../db");

const router = express.Router();

const PAGE_SIZE = 50;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function page(body) {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ad Magnet DB — Admin</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config = { darkMode: 'class' }</script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen p-6">
  <div class="max-w-5xl mx-auto space-y-6">
    <h1 class="text-2xl font-semibold">Ad Magnet DB</h1>
    <p class="text-slate-400 text-sm">
      Read-only view of the external ad/lead-magnet database, connected via
      <code class="text-slate-300">AD_MAGNET_MONGODB_URI</code>.
    </p>
    ${body}
  </div>
</body>
</html>`;
}

// GET /admin/ad-magnet — list collections, or documents if ?collection=name
router.get("/", async (req, res, next) => {
  try {
    const conn = getAdMagnetConnection();
    if (!conn) {
      return res.send(
        page(
          `<div class="rounded-md bg-amber-950 border border-amber-800 px-4 py-2 text-sm text-amber-300">
            Not configured. Set <code>AD_MAGNET_MONGODB_URI</code> in .env and restart.
          </div>`
        )
      );
    }

    const collections = await conn.db.listCollections().toArray();
    const collectionNames = collections.map((c) => c.name).sort();

    const selected = req.query.collection;
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);

    const collectionList = `<div class="flex flex-wrap gap-2">
      ${collectionNames
        .map(
          (name) => `<a href="/admin/ad-magnet?collection=${encodeURIComponent(name)}"
              class="px-3 py-1 rounded text-sm border ${
                name === selected
                  ? "bg-indigo-700 border-indigo-600"
                  : "bg-slate-900 border-slate-800 hover:bg-slate-800"
              }">${esc(name)}</a>`
        )
        .join("")}
    </div>`;

    if (!selected) {
      return res.send(
        page(
          collectionNames.length
            ? collectionList
            : `<p class="text-slate-500">No collections found in this database.</p>`
        )
      );
    }

    if (!collectionNames.includes(selected)) {
      return res.status(404).send(
        page(`${collectionList}<p class="text-red-400 mt-4">Unknown collection "${esc(selected)}"</p>`)
      );
    }

    const coll = conn.db.collection(selected);
    const total = await coll.estimatedDocumentCount();
    const docs = await coll
      .find({})
      .sort({ _id: -1 })
      .skip((pageNum - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .toArray();

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const rows = docs
      .map(
        (doc) =>
          `<tr class="border-t border-slate-800 align-top">
            <td class="py-2 pr-4 font-mono text-xs text-slate-500 whitespace-nowrap">${esc(doc._id)}</td>
            <td class="py-2 font-mono text-xs whitespace-pre-wrap break-all">${esc(
              JSON.stringify(doc, null, 2)
            )}</td>
          </tr>`
      )
      .join("");

    const pager = `<div class="flex items-center gap-3 text-sm text-slate-400">
      <span>Page ${pageNum} of ${totalPages} (${total} documents)</span>
      ${
        pageNum > 1
          ? `<a class="underline" href="/admin/ad-magnet?collection=${encodeURIComponent(selected)}&page=${pageNum - 1}">prev</a>`
          : ""
      }
      ${
        pageNum < totalPages
          ? `<a class="underline" href="/admin/ad-magnet?collection=${encodeURIComponent(selected)}&page=${pageNum + 1}">next</a>`
          : ""
      }
    </div>`;

    return res.send(
      page(`
        ${collectionList}
        ${pager}
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-slate-500">
              <th class="py-2 pr-4">_id</th>
              <th class="py-2">document</th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan="2" class="py-4 text-slate-500">No documents.</td></tr>`}
          </tbody>
        </table>
        ${pager}
      `)
    );
  } catch (err) {
    next(err);
  }
});

router.use((err, req, res, _next) => {
  res.status(err.status || 500).send(
    page(`<div class="rounded-md bg-red-950 border border-red-800 px-4 py-2 text-sm text-red-300">${esc(err.message)}</div>`)
  );
});

module.exports = router;
