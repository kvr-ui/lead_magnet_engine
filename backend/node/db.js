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

// Separate live connection to an external ad/lead-magnet database. Kept
// apart from the core connection above on purpose — different deployment,
// different lifecycle, queried read-only for display. Optional: if
// AD_MAGNET_MONGODB_URI isn't set, adMagnetConnection stays null and callers
// should treat the feature as unconfigured rather than fail startup.
let adMagnetConnection = null;

async function connectAdMagnetDB() {
  const uri = process.env.AD_MAGNET_MONGODB_URI;
  if (!uri) return null;
  if (adMagnetConnection) return adMagnetConnection;

  adMagnetConnection = mongoose.createConnection(uri);
  adMagnetConnection.on("error", (err) => {
    console.error("Ad-magnet MongoDB connection error:", err.message);
  });
  await adMagnetConnection.asPromise();
  console.log(`Ad-magnet MongoDB connected: ${uri}`);
  return adMagnetConnection;
}

function getAdMagnetConnection() {
  return adMagnetConnection;
}

module.exports = { connectDB, connectAdMagnetDB, getAdMagnetConnection, mongoose };
