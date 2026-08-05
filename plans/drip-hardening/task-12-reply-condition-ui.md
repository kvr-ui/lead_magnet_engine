---
task: 12
name: reply-condition-ui
parallel_group: 3
depends_on: [9]
issue: 40
---

# Task 12: Reply/button condition config UI + validation

## What to build

The reply and button condition evaluators from task 9 cannot be configured from the flow
canvas until the node configuration panel knows about them. Add them.

Extend the condition node's kind selector with the two new options, each with a short hint
written in the same plain register as the existing ones — what the branch asks, not how it
is implemented. For each, add a configuration sub-panel that reuses the existing
engagement panel's upstream-message-node picker (including how it handles a node that has
since been deleted) plus:

- a match mode — substring or whole value;
- a repeatable list of words, phrases or button labels to match, using the same add/remove
  chip pattern the filter conditions already use.

Add matching validation rules alongside the existing condition warnings, in the shared
validation module so the canvas and the publish check agree:

- no upstream message node selected, or one that no longer exists in the graph;
- no values configured to match against;
- and most importantly, the existing "reachable without an intervening wait" heuristic.
  A reply or button condition evaluated in the same tick as the send it depends on can
  never see an answer, because no human has had time to respond. That is a
  no-error-but-always-wrong graph, exactly the class of mistake this heuristic exists to
  catch, and it must warn for the new kinds as it does for engagement.

Distinguish errors from warnings the way the module already does: a missing upstream node
is a broken graph, while "no wait before this check" is a warning an operator may
knowingly accept.

**Boundary:** this task is frontend configuration and validation only. The evaluators
themselves are task 9.

## Acceptance criteria

- [ ] The condition kind selector offers reply and button kinds with hints in the existing register
- [ ] Each new kind has a sub-panel with an upstream message picker, a match mode, and a repeatable values list
- [ ] The existing upstream-message picker and its deleted-node handling are reused, not reimplemented
- [ ] Validation flags a missing or deleted upstream message node as an error
- [ ] Validation flags an empty values list
- [ ] Validation warns when a reply or button condition is reachable from its message node without an intervening wait
- [ ] Existing condition kinds and their warnings are unchanged
- [ ] Configuring a node produces exactly the config shape the task 9 evaluators read
- [ ] The frontend builds clean

## Commit convention

Your commit message MUST include `Closes #<issue-number>` so the task's GitHub issue
closes when the commit lands on the default branch.
