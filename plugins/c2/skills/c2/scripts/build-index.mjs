#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// c2: catalog build batch job
// Purpose: crawl skills/plugins/MCP servers once and store them in catalog.jsonl. No LLM calls —
// HTTP only — so this stays nearly free to run on a weekly schedule (see setup-schedule.*).
// Usage: node build-index.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CATALOG, CATALOG_SCHEMA_VERSION, CODEX_HOME, DATA_DIR, META, clipped, embedTexts, loadConfig, parseFrontmatter, resolveProvider, walk, withCatalogMetadata, writeAtomic, writeVectors } from './catalog.mjs';

const config = loadConfig();
const errors = [];
const entries = [];
const home = os.homedir();
const add = (entry) => entries.push(withCatalogMetadata({ tags: [], ...entry }));

const fetchOk = async (url) => {
    const response = await fetch(url, { headers: { 'User-Agent': 'c2-codex-concierge' } });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response;
};
const fetchJson = (url) => fetchOk(url).then((response) => response.json());
const fetchText = (url) => fetchOk(url).then((response) => response.text());

// External catalog data (aitmpl.com's component `path`) ends up embedded verbatim in an install
// command that a user may copy-paste and run. Restrict it to a safe segment charset before that
// happens, the same guard c3 applies to the same source, so a poisoned upstream entry can't smuggle
// shell metacharacters into a recommendation.
// Segment charset includes "." (in addition to alnum/_/-) so legitimate versioned paths like
// "tools/v1.2-migrate" aren't silently dropped from the catalog. (/code-review, ported from c3)
const SAFE_CATALOG_PATH = /^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/;
function safeCatalogPath(value, source) {
    const candidate = String(value || '').trim();
    if (!SAFE_CATALOG_PATH.test(candidate)) {
        errors.push(`${source}: skipped unsafe path ${JSON.stringify(candidate).slice(0, 120)}`);
        return null;
    }
    return candidate;
}

// safeCatalogPath is an allowlist shaped for aitmpl.com's path-like values; it's too strict for
// free-form external values (URLs, package identifiers) from other sources that get interpolated
// into install: strings the same way. This denylist variant rejects shell metacharacters/control
// characters instead, so it fits VoltAgent README URLs and MCP registry fields. Applying it only to
// aitmpl.com and leaving the other sources unguarded was a gap found in /code-review (ported from c3).
const UNSAFE_INSTALL_CHARS = /[;&|`$()<>\n\r"'\\]/;
function safeForInstallString(value, source) {
    const candidate = String(value || '').trim();
    if (!candidate || UNSAFE_INSTALL_CHARS.test(candidate)) {
        errors.push(`${source}: skipped unsafe value ${JSON.stringify(candidate).slice(0, 120)}`);
        return null;
    }
    return candidate;
}

// --- Source: skills already installed in this Codex environment ---
// Indexed first (and unconditionally, before any network source) so "you already have this" is
// always available to the reuse-first recommendation policy.
function pluginNameFor(file, root) {
    let directory = path.dirname(file);
    const boundary = path.resolve(root);
    while (directory.startsWith(boundary)) {
        const manifest = path.join(directory, '.codex-plugin', 'plugin.json');
        if (fs.existsSync(manifest)) {
            try { return JSON.parse(fs.readFileSync(manifest, 'utf8')).name || path.basename(directory); }
            catch (error) { errors.push(`plugin:${manifest}: ${error.message}`); return null; }
        }
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    return null;
}

function indexSkills(root, source) {
    for (const file of walk(root, (candidate) => path.basename(candidate) === 'SKILL.md')) {
        try {
            const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
            add({
                kind: 'skill',
                name: fm.name || path.basename(path.dirname(file)),
                description: fm.description || '',
                source,
                install: 'Already available in this Codex environment.',
                fulltext: clipped(fm.body),
                distribution: 'installed',
                surface: ['cli', 'ide', 'desktop'],
                parentPlugin: pluginNameFor(file, root),
            });
        } catch (error) { errors.push(`skill:${file}: ${error.message}`); }
    }
}

// --- Source: plugins already installed (Codex plugin dirs + the user's personal marketplace) ---
function indexPlugins(root, source) {
    const isPluginManifest = (candidate) => path.basename(candidate) === 'plugin.json' && path.basename(path.dirname(candidate)) === '.codex-plugin';
    for (const file of walk(root, isPluginManifest)) {
        try {
            const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
            add({
                kind: 'plugin',
                name: manifest.name || path.basename(path.dirname(path.dirname(file))),
                description: manifest.description || manifest.interface?.shortDescription || '',
                source,
                tags: manifest.interface?.capabilities || [],
                install: 'Already available in this Codex environment.',
                license: manifest.license || 'unknown',
                distribution: 'installed',
                surface: ['cli', 'desktop'],
            });
        } catch (error) { errors.push(`plugin:${file}: ${error.message}`); }
    }
}

// --- Source: the user's personal plugin marketplace (~/.agents/plugins/marketplace.json) ---
function indexMarketplace() {
    const file = path.join(home, '.agents', 'plugins', 'marketplace.json');
    if (!fs.existsSync(file)) return;
    try {
        const marketplace = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const plugin of marketplace.plugins || []) {
            if (!plugin.name) continue;
            add({
                kind: 'plugin',
                name: plugin.name,
                description: plugin.description || '',
                source: `marketplace:${marketplace.name || 'personal'}`,
                tags: [plugin.category].filter(Boolean),
                install: 'Install or enable it from the Codex Plugins view.',
                distribution: 'installable',
                surface: ['cli', 'desktop'],
            });
        }
    } catch (error) { errors.push(`marketplace: ${error.message}`); }
}

// --- Shared helper for GitHub repos that hold many SKILL.md files ---
// The tree API lists every path in one request; each SKILL.md's frontmatter is then fetched in
// parallel. Fine for repos with a few dozen skills — do not reuse this for a source with hundreds
// of entries (see indexTemplates / indexMcpRegistry, which use a single-file or paginated API instead).
async function indexRepoSkills(repo, ref, source, install) {
    const tree = await fetchJson(`https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`);
    const paths = (tree.tree || []).map((entry) => entry.path).filter((file) => /(^|\/)SKILL\.md$/.test(file));
    const records = await Promise.allSettled(paths.map(async (file) => {
        const fm = parseFrontmatter(await fetchText(`https://raw.githubusercontent.com/${repo}/${ref}/${file}`));
        return {
            kind: 'skill',
            name: fm.name || path.basename(path.dirname(file)),
            description: fm.description || '',
            source,
            tags: source === 'openai/skills' ? ['official'] : ['community'],
            install: install(file),
            fulltext: clipped(fm.body),
            distribution: source === 'openai/skills' ? 'installable' : 'copy-and-adapt',
            surface: ['cli', 'ide', 'desktop'],
        };
    }));
    records.forEach((record, index) => {
        if (record.status === 'fulfilled') add(record.value);
        else errors.push(`${source}:${paths[index]}: ${record.reason?.message || record.reason}`);
    });
}

// --- Source: openai/skills — official OpenAI skills ---
async function indexOpenAISkills() {
    return indexRepoSkills('openai/skills', 'main', 'openai/skills', (file) => `Use skill-installer with https://github.com/openai/skills/tree/main/${path.dirname(file)}`);
}

// --- Source: anthropics/skills — cross-ecosystem leads, not directly installable in Codex ---
async function indexAnthropicSkills() {
    return indexRepoSkills('anthropics/skills', 'main', 'anthropics/skills', (file) => `Review and copy the compatible skill directory from https://github.com/anthropics/skills/tree/main/${path.dirname(file)} into a Codex skills location.`);
}

// --- Source: VoltAgent/awesome-agent-skills — vendor + community skill list ---
// One README fetch, then a line-format regex extracts every entry (avoids one request per skill).
async function indexVoltAgentSkills() {
    const text = await fetchText('https://raw.githubusercontent.com/VoltAgent/awesome-agent-skills/main/README.md');
    const pattern = /^\s*-\s*\*\*\[([^\]]+)\]\(([^)]+)\)\*\*\s*[-–—]\s*(.+)$/gm;
    let match;
    while ((match = pattern.exec(text))) {
        // match[2] is captured via [^)]+, so it can contain spaces, backticks, $(), semicolons,
        // etc. Validate before it reaches an install: string a user might copy-paste and run.
        const url = safeForInstallString(match[2], 'VoltAgent/awesome-agent-skills');
        if (!url) continue;
        add({
            kind: 'skill',
            name: match[1].trim(),
            description: match[3].trim(),
            source: 'VoltAgent/awesome-agent-skills',
            tags: ['community'],
            install: `Review ${url} and adapt the skill for Codex before installation.`,
            distribution: 'copy-and-adapt',
            surface: ['unknown'],
        });
    }
}

// --- Source: aitmpl.com (davila7/claude-code-templates) component catalog ---
// One components.json fetch covers hundreds of community skill templates with descriptions.
async function indexTemplates() {
    const catalog = await fetchJson('https://raw.githubusercontent.com/davila7/claude-code-templates/main/docs/components.json');
    for (const skill of catalog.skills || []) {
        const skillPath = safeCatalogPath(skill.path, 'aitmpl.com');
        if (!skillPath) continue;
        add({
            kind: 'skill',
            // name uses the path (e.g. security/security-audit) because names collide across categories.
            name: skillPath,
            description: (skill.description || '').slice(0, 300),
            source: 'aitmpl.com',
            tags: [skill.category, ...(Array.isArray(skill.keywords) ? skill.keywords : [])].filter(Boolean).slice(0, 12),
            install: 'Community template: review and adapt it for Codex before installation.',
            distribution: 'copy-and-adapt',
            surface: ['unknown'],
        });
    }
}

// --- Source: official MCP Registry (registry.modelcontextprotocol.io) ---
async function indexMcpRegistry() {
    // The registry returns a server's older versions before its current one, so this needs
    // last-write-wins-by-name — the opposite of the global first-write-wins dedup applied below —
    // to end up with the newest record for each server. A local Map handles that before add() runs.
    const byName = new Map();
    let cursor;
    for (let page = 0; page < 60; page += 1) {
        const url = new URL('https://registry.modelcontextprotocol.io/v0/servers');
        url.searchParams.set('limit', '100');
        if (cursor) url.searchParams.set('cursor', cursor);
        const result = await fetchJson(url);
        for (const row of result.servers || []) {
            const server = row.server || row;
            if (!server.name) continue;
            const status = row._meta?.['io.modelcontextprotocol.registry/official']?.status;
            if (status && status !== 'active') continue;
            // Prefer a remote transport; fall back to an npm package; otherwise point at the registry.
            // remote.url / packageInfo.identifier are external data too, so validate them before
            // they land in an install: string, same as aitmpl.com's path. (/code-review, ported from c3)
            const remote = server.remotes?.[0];
            const packageInfo = server.packages?.[0];
            let install = 'Review the server in the MCP Registry before configuring it in Codex.';
            const remoteUrl = remote?.url && safeForInstallString(remote.url, 'mcp-registry');
            const packageId = packageInfo && safeForInstallString(packageInfo.identifier || packageInfo.name || '', 'mcp-registry');
            if (remoteUrl) install = `codex mcp add ${server.name} --url ${remoteUrl}`;
            else if (packageId) install = `codex mcp add ${server.name} -- npx -y ${packageId}`;
            byName.set(server.name, {
                kind: 'mcp', name: server.name, description: server.description || '', source: 'MCP Registry', install,
                // `status` is the registry record lifecycle, not publisher verification. Keep
                // provenance unknown unless a dedicated verified-publisher field is available.
                sourceClass: 'unknown',
                distribution: 'installable', surface: ['cli', 'ide', 'desktop'],
            });
        }
        cursor = result.metadata?.nextCursor;
        if (!cursor) break;
    }
    for (const entry of byName.values()) add(entry);
}

// Installed assets are indexed synchronously and unconditionally first; every entry() call inside
// them is individually try/caught, so a broken frontmatter file or plugin.json can't abort the run.
indexSkills(path.join(CODEX_HOME, 'skills'), 'installed');
indexSkills(path.join(CODEX_HOME, 'plugins'), 'installed-plugin');
indexPlugins(path.join(CODEX_HOME, 'plugins'), 'installed');
indexPlugins(path.join(home, '.agents', 'plugins'), 'installed');
indexMarketplace();

// Network sources run in parallel (wall-clock = slowest source, not the sum of all of them).
// Array order is also dedup priority below: installed (already run) -> official -> community -> registry.
const jobs = [
    ['openai/skills', indexOpenAISkills],
    ['anthropics/skills', indexAnthropicSkills],
    ['VoltAgent skills', indexVoltAgentSkills],
    ['templates', indexTemplates],
    ['MCP Registry', indexMcpRegistry],
];
const results = await Promise.allSettled(jobs.map(([, job]) => job()));
results.forEach((result, index) => {
    if (result.status === 'rejected') errors.push(`${jobs[index][0]}: ${result.reason?.message || result.reason}`);
});

// Dedup by kind+name, first entry wins. Because entries were appended in priority order above
// (installed -> official -> community -> registry), first-wins is the same thing as priority-wins.
const seen = new Set();
const unique = entries.filter((entry) => {
    const key = `${entry.kind}:${entry.name}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
});

// Lite install (--no-fulltext): drop body vocabulary to roughly halve the catalog's on-disk size.
if (config.fulltext === false) for (const entry of unique) delete entry.fulltext;

fs.mkdirSync(DATA_DIR, { recursive: true });
writeAtomic(CATALOG, `${unique.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

// Vector build (--vectors <provider>): embed name+tags+description only. Full body text isn't
// embedded — the description is enough for routing, and it costs a fraction of the tokens.
let vectors = false;
const provider = resolveProvider(config);
if (provider?.missingKey) {
    errors.push(`vectors: ${provider.missingKey} is not set; using lexical search.`);
} else if (provider) {
    try {
        const texts = unique.map((entry) => `${entry.name}. ${(entry.tags || []).join(' ')}. ${entry.description}`.slice(0, 1500));
        const vectorsData = await embedTexts(texts, provider);
        writeVectors(vectorsData, { provider: provider.name, model: provider.model, builtAt: new Date().toISOString() });
        vectors = true;
    } catch (error) { errors.push(`vectors: ${error.message}`); }
}

const counts = Object.fromEntries(['skill', 'plugin', 'mcp'].map((kind) => [kind, unique.filter((entry) => entry.kind === kind).length]));
const meta = { schemaVersion: CATALOG_SCHEMA_VERSION, builtAt: new Date().toISOString(), total: unique.length, counts, fulltext: config.fulltext !== false, vectors, errors };
fs.writeFileSync(META, JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta, null, 2));
