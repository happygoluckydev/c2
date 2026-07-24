# v0.1 comparison benchmark (20 tasks)

Use the same task with three setups and record whether c2 beat the baseline.

| Setup | What to use |
|---|---|
| A | No c2 — memory / bookmarks only |
| B | Official Codex surfaces only (built-ins, installed skills/plugins, Plugins view) |
| C | c2 (`/c2` or `/cc`) |

Score each task yes/no:

1. A useful candidate appeared in the top 3
2. It was installable or already available
3. Built-ins / existing assets were preferred when enough
4. License or safety was not misrepresented
5. Research time / tokens dropped meaningfully vs A or B

Continue after v0.1 if at least one holds: ≥5/10 users reuse c2, ≥6/20 tasks beat official-only discovery, research time halves, or license/safety/existing-asset priority is praised.

## Tasks

1. GitHub PR review comments
2. Slack notification from a workflow
3. Linear issue triage
4. Stripe billing integration helper
5. PDF text extraction skill
6. Spreadsheet cleanup
7. Google Drive file search
8. Calendar scheduling assistant
9. Postgres migration assistant
10. CI failure diagnosis
11. Security review of an auth change
12. Accessibility review of a UI change
13. OpenAPI-to-docs generation
14. Browser E2E test scaffold
15. Observability / logging helper
16. Customer support reply drafting
17. Multi-file refactor with tests
18. Local MCP server for a SaaS API
19. Find an already-installed skill before adding another
20. Prune unused installed skills / reduce resident context
