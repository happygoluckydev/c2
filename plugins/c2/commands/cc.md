---
description: Alias for /c2. Find reusable Codex capabilities before building.
---

# /cc

Treat `/cc` exactly like `/c2`.

Use the `c2` skill for this request. Treat `$ARGUMENTS` as the task to evaluate.

Keep the command quiet: do not send progress narration before running the catalog search unless the command is blocked or takes long enough that a brief status update is needed.

If `$ARGUMENTS` is empty, ask the user what task they want to check for reusable Codex capabilities.

Otherwise, follow the `c2` skill instructions in `skills/c2/SKILL.md` mechanically, including task normalization, keyword extraction, local catalog search, finalist retrieval, priority selection, safety notes, and the required response.

Do not install, enable, authorize, or remove anything unless `$ARGUMENTS` explicitly asks for that action.
