// SPDX-License-Identifier: MIT
// c2: shared module — path constants, config, frontmatter parser, embedding provider, vector I/O
// (Mirrors c3's skills/ccc/scripts/embed.mjs, adapted for the Codex home layout.)
// - API keys are read from environment variables only; never written to config, catalog, or logs.
// - Vectors are L2-normalized and stored as a raw Float32Array binary (JSON would be ~4x larger).
// - No dependencies: everything below is Node.js standard library plus direct REST calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ~/.codex/c2 is the single data store for this tool. Path constants live only here so a future
// edit can't create a split-brain between build-index/search/prune reading different locations.
export const CODEX_HOME = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
export const DATA_DIR = path.join(CODEX_HOME, 'c2');
export const CATALOG = path.join(DATA_DIR, 'catalog.jsonl');
export const META = path.join(DATA_DIR, 'meta.json');
export const VEC_BIN = path.join(DATA_DIR, 'vectors.bin');
export const VEC_META = path.join(DATA_DIR, 'vectors.json');
export const CATALOG_SCHEMA_VERSION = 3;
const CONFIG = path.join(DATA_DIR, 'config.json');

// Defaults when config.json is absent = historical behavior (index body text, no vectors).
const DEFAULTS = { fulltext: true, vectors: { provider: 'none' } };

// Minimal YAML frontmatter parser (name/description only — a full parser would add a dependency
// for two fields we actually use). fmLen is the frontmatter's character length, used by prune.mjs
// to estimate the resident-context "tax" a skill costs every session. body is the vocabulary used
// for full-text search.
export function parseFrontmatter(text) {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const result = {
        fmLen: match ? match[0].length : 0,
        body: (match ? text.slice(match[0].length) : text).trim(),
    };
    if (!match) return result;
    for (const line of match[1].split(/\r?\n/)) {
        const field = line.match(/^(name|description)\s*:\s*(.*)$/);
        if (field) result[field[1]] = field[2].trim().replace(/^['"]|['"]$/g, '');
    }
    return result;
}

// First 4000 characters only: keeps the catalog from bloating while still capturing the
// vocabulary-dense opening of most SKILL.md / plugin docs, so recall barely suffers.
export const clipped = (text = '') => text.replace(/\0/g, '').slice(0, 4000);

// Shared catalog contract with c3 (see CATALOG_SCHEMA.md). `availability` is install state;
// `packaging` is how the capability is shipped. Legacy `distribution` is migration-only input.
const AVAILABILITIES = new Set(['built-in', 'installed', 'installable', 'copy-and-adapt', 'authoring-required', 'unknown']);
const PACKAGINGS = new Set(['built-in', 'standalone', 'plugin', 'plugin-component', 'unknown']);
const EXECUTIONS = new Set(['prompt', 'isolated-agent', 'deterministic-hook', 'external-service', 'background-monitor', 'unknown']);
const SOURCE_CLASSES = new Set(['official', 'community', 'unknown']);
const MATURITY_LEVELS = new Set(['stable', 'experimental', 'deprecated', 'unknown']);
const EXECUTION_ALIASES = {
    deterministic: 'deterministic-hook',
    background: 'background-monitor',
    agent: 'isolated-agent',
};
export const metadataWarnings = [];
const LEGACY_PACKAGING = {
    builtin: 'built-in',
    'built-in': 'built-in',
    standalone: 'standalone',
    plugin: 'plugin',
    'plugin-component': 'plugin-component',
};
const LEGACY_AVAILABILITY = {
    'built-in': 'built-in',
    installed: 'installed',
    installable: 'installable',
    'copy-and-adapt': 'copy-and-adapt',
    'authoring-required': 'authoring-required',
};
const list = (value, fallback) => {
    const items = (Array.isArray(value) ? value : value ? [value] : []).map((item) => String(item).trim()).filter(Boolean);
    return items.length ? [...new Set(items)] : fallback;
};

function migrateDistribution(distribution) {
    const value = String(distribution || '').trim().toLowerCase();
    if (!value) return { availability: 'unknown', packaging: 'unknown' };
    if (LEGACY_PACKAGING[value]) {
        const packaging = LEGACY_PACKAGING[value];
        return { availability: value === 'built-in' ? 'built-in' : 'unknown', packaging };
    }
    if (LEGACY_AVAILABILITY[value]) {
        return {
            availability: LEGACY_AVAILABILITY[value],
            packaging: value === 'built-in' ? 'built-in' : 'unknown',
        };
    }
    return { availability: 'unknown', packaging: 'unknown' };
}

export function inferSourceClass(source = '') {
    if (source === 'openai/skills') return 'official';
    if (['anthropics/skills', 'VoltAgent/awesome-agent-skills', 'aitmpl.com'].includes(source)) return 'community';
    return 'unknown';
}

export function withCatalogMetadata(entry) {
    const migrated = migrateDistribution(entry.distribution);
    const normalizeEnum = (field, value, allowed) => {
        const normalized = String(value ?? '').trim().toLowerCase();
        if (!normalized) return null;
        if (allowed.has(normalized)) return normalized;
        metadataWarnings.push(`${field}=${String(value).trim().replace(/[\t\n\r]/g, ' ').slice(0, 100)}`);
        return null;
    };
    const availabilityInput = normalizeEnum('availability', entry.availability, AVAILABILITIES);
    const packagingInput = normalizeEnum('packaging', entry.packaging, PACKAGINGS);
    const executionValue = normalizeEnum('execution', entry.execution, new Set([...EXECUTIONS, ...Object.keys(EXECUTION_ALIASES)]));
    const executionRaw = executionValue ? EXECUTION_ALIASES[executionValue] || executionValue : null;
    const sourceClass = normalizeEnum('sourceClass', entry.sourceClass, SOURCE_CLASSES) || inferSourceClass(entry.source);
    const maturity = normalizeEnum('maturity', entry.maturity, MATURITY_LEVELS);
    const { distribution, ...rest } = entry;
    return {
        ...rest,
        id: entry.id || `${entry.kind}:${entry.name}`,
        platform: entry.platform || 'codex',
        availability: availabilityInput || migrated.availability,
        packaging: packagingInput || migrated.packaging,
        domain: entry.domain || 'unknown',
        execution: executionRaw || 'unknown',
        sourceClass,
        license: String(entry.license || 'unknown').trim() || 'unknown',
        maturity: maturity || 'unknown',
        surface: list(entry.surface, ['unknown']),
        parentPlugin: entry.parentPlugin || null,
        permissions: list(entry.permissions, ['unknown']),
    };
}

function recordId(entry) {
    return String(entry.id || `${entry.kind}:${entry.name}`).toLowerCase();
}

export function resolveCatalogRecords(docs, requestedValues) {
    const byId = new Map();
    const byName = new Map();
    for (const doc of docs) {
        const id = recordId(doc);
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push(doc);
        const name = String(doc.name || '').toLowerCase();
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push(doc);
    }

    const requested = [];
    const missing = [];
    const ambiguous = [];
    const fallback = [];
    const selected = new Set();
    const resolve = (value) => {
        const normalized = value.trim().toLowerCase();
        if (!normalized) return;
        requested.push(normalized);
        const idMatches = byId.get(normalized) || [];
        if (idMatches.length === 1) {
            selected.add(idMatches[0]);
            return;
        }
        if (idMatches.length > 1) {
            ambiguous.push(normalized);
            return;
        }
        const nameMatches = byName.get(normalized) || [];
        if (nameMatches.length === 1) selected.add(nameMatches[0]);
        else if (nameMatches.length > 1) ambiguous.push(normalized);
        else missing.push(normalized);
    };

    for (const original of requestedValues) {
        const raw = String(original ?? '').trim();
        if (!raw) continue;
        const wholeId = byId.get(raw.toLowerCase()) || [];
        if (raw.includes(',') && wholeId.length === 1) {
            requested.push(raw.toLowerCase());
            selected.add(wholeId[0]);
            fallback.push(raw.toLowerCase());
            continue;
        }
        for (const value of raw.split(',')) resolve(value);
    }

    return {
        records: docs.filter((doc) => selected.has(doc)),
        requested,
        missing: [...new Set(missing)],
        ambiguous: [...new Set(ambiguous)],
        fallback: [...new Set(fallback)],
    };
}

// Write-then-rename so a crash mid-write can never leave catalog.jsonl / meta.json truncated
// or corrupted for the next search.mjs invocation.
export function writeAtomic(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
}

// Recursively collect files under root matching predicate. Skips .git/node_modules so scanning
// a user's Codex home (which may contain cloned plugin repos) stays fast and side-effect free.
export function walk(root, predicate) {
    const files = [];
    if (!fs.existsSync(root)) return files;
    const visit = (dir) => {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            if (item.name === '.git' || item.name === 'node_modules') continue;
            const file = path.join(dir, item.name);
            if (item.isDirectory()) visit(file);
            else if (predicate(file)) files.push(file);
        }
    };
    visit(root);
    return files;
}

// Reads and JSON.parses `file`, returning null if missing or unparseable. A missing file
// (ENOENT) is normal and silent; any other read/parse failure (corruption) is logged so it
// doesn't fail silently forever. Consolidates what used to be independent try/catch blocks in
// loadConfig, readVectors, and search.mjs's stale()/meta-trace reads — only loadConfig warned on
// corruption before, so the same file corrupted elsewhere failed with zero diagnostic output.
// (/code-review, ported from the equivalent c3 fix)
export function readJsonSafe(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') console.error(`c2: ignoring invalid JSON at ${file}: ${error.message}`);
        return null;
    }
}

export function loadConfig() {
    return { ...DEFAULTS, ...(readJsonSafe(CONFIG) || {}) };
}

// --- Embedding provider table ---
// Adding a provider is a single entry here (URL/request/response shape included); nothing else
// needs to change. The installer does not validate provider names, so this table is the one
// place an unknown name gets caught (resolveProvider throws on first catalog build).
const openAIStyle = (url) => ({
    request: (input, p) => [url, { Authorization: `Bearer ${p.key}` }, { model: p.model, input }],
    extract: (body) => body.data.map((row) => row.embedding),
});
const PROVIDERS = {
    gemini: {
        keyEnv: 'GEMINI_API_KEY', model: 'text-embedding-004', batch: 100,
        request: (input, p) => [
            `https://generativelanguage.googleapis.com/v1beta/models/${p.model}:batchEmbedContents?key=${p.key}`,
            {},
            { requests: input.map((text) => ({ model: `models/${p.model}`, content: { parts: [{ text }] } })) },
        ],
        extract: (body) => body.embeddings.map((row) => row.values),
    },
    voyage: { keyEnv: 'VOYAGE_API_KEY', model: 'voyage-3.5-lite', batch: 128, ...openAIStyle('https://api.voyageai.com/v1/embeddings') },
    openai: { keyEnv: 'OPENAI_API_KEY', model: 'text-embedding-3-small', batch: 256, ...openAIStyle('https://api.openai.com/v1/embeddings') },
};

// Returns: null (vectors disabled) / {missingKey} (provider selected but key unset) /
// {name,key,model,batch,request,extract} (ready to use).
export function resolveProvider(config) {
    const selection = config.vectors || {};
    if (!selection.provider || selection.provider === 'none') return null;
    const provider = PROVIDERS[selection.provider];
    if (!provider) throw new Error(`Unknown vector provider: ${selection.provider} (supported: ${Object.keys(PROVIDERS).join('/')})`);
    const keyEnv = selection.apiKeyEnv || provider.keyEnv;
    const key = process.env[keyEnv];
    if (!key) return { name: selection.provider, missingKey: keyEnv };
    return { name: selection.provider, key, model: selection.model || provider.model, batch: provider.batch, request: provider.request, extract: provider.extract };
}

async function post(url, headers, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Embedding API HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response.json();
}

function normalize(vector) {
    const magnitude = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0)) || 1;
    return vector.map((n) => n / magnitude);
}

// texts -> normalized number[][]. Pre-normalizing means cosine similarity at query time is a
// plain dot product (no per-query sqrt work over the whole catalog).
export async function embedTexts(texts, provider) {
    const vectors = [];
    for (let i = 0; i < texts.length; i += provider.batch) {
        const chunk = texts.slice(i, i + provider.batch);
        const [url, headers, body] = provider.request(chunk, provider);
        const response = await post(url, headers, body);
        for (const vector of provider.extract(response)) vectors.push(normalize(vector));
        if (texts.length > provider.batch) process.stderr.write(`embedded ${Math.min(i + provider.batch, texts.length)}/${texts.length}\n`);
    }
    return vectors;
}

export function writeVectors(vectors, meta) {
    const dims = vectors[0] ? vectors[0].length : 0;
    const data = new Float32Array(vectors.length * dims);
    vectors.forEach((v, i) => data.set(v, i * dims));
    writeAtomic(VEC_BIN, Buffer.from(data.buffer));
    writeAtomic(VEC_META, JSON.stringify({ ...meta, dims, count: vectors.length }));
}

// expectedCount: current catalog row count. Checked against the stored count before touching the
// (potentially large) .bin file, so a catalog rebuilt without a matching re-embed is detected
// cheaply instead of silently reading vectors that no longer line up with catalog.jsonl rows.
// The byte-length check uses fs.statSync (metadata only) before fs.readFileSync, so a corrupted
// or truncated vectors.bin is rejected without paying for reading it into memory first.
// (/code-review, ported from the equivalent c3 fix)
export function readVectors(expectedCount) {
    const meta = readJsonSafe(VEC_META);
    if (!meta || !meta.dims || (expectedCount != null && meta.count !== expectedCount)) return null;
    const expectedBytes = meta.dims * meta.count * Float32Array.BYTES_PER_ELEMENT;
    try {
        if (fs.statSync(VEC_BIN).size !== expectedBytes) return null;
        const data = fs.readFileSync(VEC_BIN);
        return { meta, data: new Float32Array(data.buffer, data.byteOffset, data.length / 4) };
    } catch (error) {
        if (error.code !== 'ENOENT') console.error(`c2: ignoring invalid vectors file ${VEC_BIN}: ${error.message}`);
        return null;
    }
}
