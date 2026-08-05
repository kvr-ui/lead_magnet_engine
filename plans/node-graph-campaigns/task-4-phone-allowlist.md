---
task: 4
name: phone-allowlist
parallel_group: 1
depends_on: []
issue: 5
---

# Task 4: Env-gated send allowlist for real end-to-end drip testing

## What to build

This is a WhatsApp drip-campaign admin tool (Node/Express backend at `backend/node` using Mongoose, React 19 + Vite frontend at `frontend/admin-ui`, WATI as the WhatsApp provider). There is already a global kill switch — `isSendingEnabled()` in `backend/node/lib/sendingSwitch.js` — checked at the very top of `sendMessage` in `backend/node/lib/whatsappProvider.js` (around line 42) before any network call or provider lookup. That switch is all-or-nothing: it is either safe-mode (nothing sends) or live (everything sends). To run a genuine end-to-end drip test against real WATI infrastructure — real templates, real delivery/read webhooks flowing back — without any possibility of a graph bug or test misconfiguration reaching any of the ~5,982 real leads currently queued to enroll, we need a narrower gate than the kill switch: an allowlist of specific phone numbers that are the only ones allowed to actually leave the building while everyone else is silently (but visibly, in logs) dropped.

Build the following:

1. **Allowlist check in `backend/node/lib/whatsappProvider.js`.** In `sendMessage({ phone, templateId, params, channelId, meta })`, immediately after the existing `if (!(await isSendingEnabled())) throw sendingDisabledError();` line (around line 42) and before the provider-doc lookup, add: if `process.env.SEND_PHONE_ALLOWLIST` is set (a comma-separated list of phone numbers), parse it into a set of cleaned/trimmed entries and check whether the `phone` argument (already cleaned by the caller — see `backend/node/lib/phone.js`'s `cleanPhone`, which produces `"<countryCode><10 digits>"` with no leading `+`, e.g. `"919876543210"`) is a member. Split the env var on commas, trim whitespace from each entry, and strip any leading `+` and non-digit characters from each entry before comparing, so the env var can be written in either `+919876543210` or `919876543210` form and still match the internally-cleaned phone string. If the phone is not on the list, do not call the provider at all — throw an error carrying a distinguishing flag, e.g.:
   ```js
   function notAllowlistedError(phone) {
     const err = new Error(`Phone ${phone} is not on SEND_PHONE_ALLOWLIST — send dropped`);
     err.notAllowlisted = true;
     return err;
   }
   ```
   Log a clear, single line naming the dropped number and template (e.g. `console.log(\`[allowlist] dropped send to ${phone} (template ${templateId}) — not on SEND_PHONE_ALLOWLIST\`)`) so a test run's console output makes it obvious which sends were blocked and which went through. When `SEND_PHONE_ALLOWLIST` is unset or empty, skip this check entirely — behavior must be byte-for-byte identical to today (no allowlist, no filtering, no new log lines).

2. **Caller handling in `backend/node/lib/campaignEngine.js`.** The send error path inside `advanceEnrollment` (roughly lines 267–305) already special-cases `err.sendingDisabled`: `if (err.sendingDisabled) return;` — it returns immediately, before the generic catch-all that pushes an `"error"` history entry and sets `enrollment.status = "failed"`, so a closed kill-switch leaves the enrollment queued exactly as it was, untouched. `err.notAllowlisted` must be handled identically — add it to that same short-circuit (e.g. `if (err.sendingDisabled || err.notAllowlisted) return;`) so a non-allowlisted number leaves the enrollment active/queued with no error history entry and no `"failed"` status, just like a closed kill switch does.

   The manual single-send path, `sendSingleMessage` (roughly lines 317–342), already special-cases `err.sendingDisabled` the same way: on that flag it rethrows without writing a `DirectMessage` row, because "nothing left our door" should not produce a row that reads as a failed attempt. Extend that same condition to also cover `err.notAllowlisted` (e.g. `if (err.sendingDisabled || err.notAllowlisted) throw err;`) so a manual send to a non-allowlisted number also skips the `DirectMessage.create({ ...base, status: "error", ... })` call and simply rethrows.

3. **Precedence.** The kill switch (`isSendingEnabled`) must still be checked first and independently — if sending is off, that error fires and the allowlist check is never reached, exactly as today. The allowlist is a second, narrower gate that only matters once the kill switch is open (sending is live).

**Boundary — do not touch:** the campaign graph/node schema, the graph walker/executor, or any UI. This is purely a provider-layer gate in `whatsappProvider.sendMessage` plus the two existing error-handling call sites in `campaignEngine.js` that already know how to treat "this send didn't really happen" as a no-op rather than a failure.

## Acceptance criteria

- [ ] With `SEND_PHONE_ALLOWLIST` unset (or empty string), `sendMessage` behavior is identical to before this change — no allowlist check runs, no new log lines appear, and every existing caller behaves exactly as it does today.
- [ ] With `SEND_PHONE_ALLOWLIST` set and the kill switch on (sending enabled), a call to `sendMessage` with a `phone` not present in the parsed list throws an error with `err.notAllowlisted === true`, and no call reaches `wati.sendTemplateMessage` (no network request is made) for that phone.
- [ ] With `SEND_PHONE_ALLOWLIST` set and the kill switch on, a call to `sendMessage` with a `phone` present in the list proceeds to call the provider exactly as it would with no allowlist configured.
- [ ] The allowlist parses entries tolerant of a leading `+` and surrounding whitespace, so both `+919876543210` and `919876543210` in the env var match the internally-cleaned phone format.
- [ ] With the kill switch off, `sendMessage` still throws the kill-switch error (`err.sendingDisabled === true`) regardless of the allowlist or the phone's presence on it — the kill switch takes precedence and is checked first.
- [ ] A dropped (non-allowlisted) send logs a clear line identifying the dropped phone number (and ideally the template) so it is visible in test-run console output.
- [ ] In `campaignEngine.advanceEnrollment`, when `sendMessage` throws `err.notAllowlisted`, the enrollment is left active/queued exactly as before the attempt — no `history` entry is appended and `enrollment.status` is not set to `"failed"`.
- [ ] In `campaignEngine.sendSingleMessage`, when `sendMessage` throws `err.notAllowlisted`, no `DirectMessage` document is created, and the error is rethrown to the caller.

## Commit convention

Your commit message MUST include `Closes #5` so the task's GitHub issue closes when the commit lands on the default branch.
