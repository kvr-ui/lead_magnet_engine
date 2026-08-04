const mongoose = require("mongoose");

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/wati_cleanup";

async function connectDB() {
  mongoose.connection.on("error", (err) => {
    console.error("MongoDB connection error:", err.message);
  });

  await mongoose.connect(MONGODB_URI);
  console.log(`MongoDB connected: ${MONGODB_URI}`);
}

// There used to be a second connection here, opened from AD_MAGNET_MONGODB_URI
// straight to CA Guru's database, because that one lead magnet was wired into
// the app in code. External databases are now connected as
// DataSourceConnection rows and pooled by lib/dataSourcePool.js — one
// mechanism for every lead magnet including that one, with nothing in .env and
// no connection opened at startup for a source nobody may be looking at.
module.exports = { connectDB, mongoose };
