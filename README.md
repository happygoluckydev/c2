# c2 — Codex Concierge

c2 helps you reuse existing Codex capabilities before creating a new workflow or integration. It searches a local catalog, then produces an auditable recommendation: what to reuse, what to add, what not to add, and why.

## What c2 does

- Indexes installed Codex skills, plugins, and skills bundled inside plugins
- Collects the official OpenAI Skills catalog, compatible community-skill catalogs, and active MCP Registry servers
- Searches with IDF-weighted lexical matching and full-text content by default
- Optionally combines lexical results with Gemini, Voyage, or OpenAI embeddings through Reciprocal Rank Fusion (RRF)
- Retrieves lightweight candidates with `--all`, then detailed records with `--get`
- Makes its search trace visible: catalog age, search mode, query terms, per-kind hit counts, and matched fields
- Refreshes stale catalogs automatically or on an optional weekly schedule
- Audits unused user-installed skills and archives them safely instead of deleting them

## How it works

1. c2 builds a local JSONL catalog from installed capabilities and public sources.
2. A keyword search returns a small, per-type shortlist with a visible trace.
3. c2 fetches complete records only for the finalists.
4. The c2 skill explains the recommendation, relevant exclusions, access implications, and the exact search trace.

No model call is required to build or search the catalog. A stale catalog is served immediately and refreshed in the background.

## Install

This repository contains a local Codex plugin at `plugins/c2`. Add that directory through the Codex Plugins workflow, then start a new task so Codex can discover the `c2` skill.

## Search locally

Run the scripts from the skill directory:

```powershell
Set-Location plugins/c2/skills/c2
node scripts/search.mjs --all "github pull request review" --task "Review a GitHub pull request and address comments"
node scripts/search.mjs --get "github,gh-address-comments"
```

`--all` prints candidates and their search trace. `--get` returns installation and source details for the named finalists, without returning indexed skill bodies.

The catalog is stored at `~/.codex/c2/` (or `%USERPROFILE%\.codex\c2\` on Windows), so plugin updates do not discard it. The default mode is full-text lexical search and requires no API key.

## Optional vector search

Create `~/.codex/c2/config.json`:

```json
{
  "fulltext": true,
  "vectors": { "provider": "openai" }
}
```

Supported providers are `openai`, `gemini`, and `voyage`. Set the corresponding API key (`OPENAI_API_KEY`, `GEMINI_API_KEY`, or `VOYAGE_API_KEY`) before rebuilding the catalog. When a configured key is absent or a vector request fails, c2 continues with lexical search.

Set `"fulltext": false` to reduce catalog size at the cost of recall.

## Refresh and skill audit

Run `setup-schedule.ps1` on Windows or `setup-schedule.sh` on macOS/Linux to register a weekly catalog refresh.

To audit user-installed skills, run:

```powershell
node plugins/c2/skills/c2/scripts/prune.mjs
```

This is a dry run. Add `--apply` to move unused skills to `~/.codex/skills-archive/`; no skills are deleted. Archiving is refused when no Codex session transcript is available, because usage cannot be determined safely.

## Recommendation policy

1. Reuse built-in and already installed capabilities.
2. Prefer maintained, installed, or official Codex plugins.
3. Prefer official skills for focused, repeatable work.
4. Use a reviewed compatible community skill only when it fills a real gap.
5. Recommend MCP only when live external data or actions are necessary.

Review community content before installation. Some catalog sources originated in other agent ecosystems, so they are discovery leads rather than directly installable Codex plugins. MCP servers may access data or perform actions after authorization.

## Relationship to c3

c2 adapts the architecture of [happygoluckydev/c3](https://github.com/happygoluckydev/c3) to Codex. Claude-specific agents and slash commands are represented by Codex skills and plugins; cataloging, retrieval, vector search, maintenance, and explanation features are provided in Codex-native form.

## License

MIT
