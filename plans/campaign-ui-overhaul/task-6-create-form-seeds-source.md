---
task: 6
name: create-form-seeds-source
parallel_group: 4
depends_on: [5]
issue: 23
---

# Task 6: Create form seeds a real source node

## What to build

The new-campaign form has a "Target source" dropdown that does nothing. The create endpoint accepts
only name, description, channel, and the draft graph — the target-source value it sends is discarded,
and the field it was named after no longer exists on the campaign model. A campaign's source now
lives on the source node inside its graph. So the form asks a question, and the answer is thrown
away.

The form also embeds the entire flow-canvas editor inside itself, in a mode where the canvas cannot
save or publish and merely tells the user to create the campaign first.

Fix both:

**Make the source picker real.** Keep it — choosing the source up front is the right instinct — but
have it seed an actual source node into the new campaign's initial draft graph: one node of kind
`source`, carrying the chosen source id in its config, positioned somewhere sensible on the canvas,
and labelled with the source's display name. Relabel the field so it reads as what it now is: where
the campaign's leads come from. Stop sending the discarded target-source value in the create request.

**Remove the embedded canvas** from the form. The form becomes name, description, send-from channel,
and leads-from source.

**Land the user in the flow editor.** On successful creation, open the new campaign on its Flow
sub-tab, with the seeded source node already on the canvas. The validation panel from task 4 will
then be asking for the one thing that node still needs — its phone mapping — which is exactly the
right next step.

**Clean up the dead write path.** The campaign's legacy target-source field is still *read* in a few
fallback positions, and those reads must stay: they serve campaigns created before campaigns became
graphs. Only the write goes away.

Do **not** change the sub-tab structure (task 5's work), the enrollment table (task 7), or the
confirmation dialogs (task 8). Your edits are confined to the create-campaign form and the code that
opens a newly created campaign.

## Acceptance criteria

- [ ] The create form asks only for name, description, send-from channel, and leads-from source.
- [ ] The embedded flow canvas is gone from the form.
- [ ] Creating a campaign seeds a source node into its draft graph carrying the chosen source id,
      positioned on the canvas and labelled with the source's display name.
- [ ] The discarded target-source value is no longer sent in the create request.
- [ ] After creation, the new campaign opens on its Flow sub-tab with the seeded node visible.
- [ ] The seeded node is reported by validation as needing a phone mapping.
- [ ] Existing legacy reads of the campaign's old target-source field are preserved.
- [ ] The "no WhatsApp provider connected" guard and channel-loading behaviour still work.
- [ ] `npm run build` and `npm run lint` succeed in `frontend/admin-ui`.

## Commit convention

Your commit message MUST include `Closes #23` so the task's GitHub issue closes when
the commit lands on the default branch.
