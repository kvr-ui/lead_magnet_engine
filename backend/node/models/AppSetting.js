const { Schema, model } = require("mongoose");

/**
 * Small key/value store for operator switches that must survive a restart and
 * be shared by every process touching this database — today just the global
 * sending kill switch (see lib/sendingSwitch.js). Deliberately schemaless in
 * `value` so a new switch doesn't need a migration.
 */
const appSettingSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

module.exports = model("AppSetting", appSettingSchema);
