#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// c2: local catalog search (the Retrieval half of the RAG loop)
// Uses IDF-weighted keyword matching instead of an embedding API by default — catalog entries are
// short descriptions, so this is accurate enough in practice and keeps the default path free.
//
// Two-stage design to keep the caller's (the model's) token spend low:
//   stage 1 --all : search every kind once, return a compact tab-separated shortlist (no install commands)
//   stage 2 --get : fetch full records (install commands etc.) for the finalists only
//
// Usage:
//   node search.mjs --all "<english keywords>" [--task "<original task text>"]
//   node search.mjs --get "<kind:name1,kind:name2,...>"
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CATALOG, CATALOG_SCHEMA_VERSION, DATA_DIR, META, REFRESH_LOG, embedTexts, loadConfig, readJsonSafe, readVectors, resolveProvider, withCatalogMetadata } from './catalog.mjs';

const BUILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build-index.mjs');

const args = process.argv.slice(2);
const option = (name) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : null;
};
const query = option('all');
// --task: the user's original task text (any language). Kept separate from the keyword string so
// query quality doesn't depend entirely on the calling model's keyword extraction — extra ASCII
// technical terms are pulled from the raw text too, and the raw text (not the keyword string) is
// what gets embedded when vector search is on, since embeddings handle other languages natively.
const task = option('task') || '';
const requested = option('get');

if (!query && !requested) throw new Error('Usage: --all "keywords" [--task "task"] | --get "name1,name2"');

// --- Catalog freshness ---
// --get assumes a prior --all already confirmed the catalog exists; it only needs it to be present.
// --all: build synchronously if missing (first run), or if merely stale, serve the current catalog
// immediately and refresh in a detached background process (so a query is never blocked on a
// multi-source crawl).
if (!fs.existsSync(CATALOG)) {
    if (requested) throw new Error('No catalog yet. Run a --all search first.');
    console.error('Catalog missing — building it now (HTTP only, no model call).');
    // A non-zero exit means at least one source or the vector build failed; that is only fatal if
    // no catalog landed. When a partial catalog exists, searching it beats refusing to answer, but
    // the degradation is stated rather than hidden.
    try { execFileSync(process.execPath, [BUILD], { stdio: 'inherit' }); }
    catch (error) {
        if (!fs.existsSync(CATALOG)) throw new Error(`Catalog build failed: ${error.message}`);
        console.error(`Catalog build reported failures (${error.message}); searching the partial catalog.`);
    }
} else if (query && stale()) {
    console.error(`Catalog is stale — serving it now and refreshing in the background (log: ${REFRESH_LOG}).`);
    // The background build is detached and nobody is watching its streams, so its output is
    // appended to a log file instead of being discarded: a refresh that keeps failing (network
    // blocked, corrupted data dir) used to leave no trace at all, and every later query just kept
    // reporting "stale" with no reachable explanation.
    const log = openRefreshLog();
    const refresh = spawn(process.execPath, [BUILD], { detached: true, stdio: ['ignore', log ?? 'ignore', log ?? 'ignore'] });
    refresh.on('error', (error) => console.error(`Background catalog refresh failed to start: ${error.message}`));
    refresh.unref();
    // The child owns the descriptor now; this process closing its own copy must not become a
    // failure of the search itself (spawn may already have closed it).
    if (log !== null) try { fs.closeSync(log); } catch { /* already closed by spawn */ }
}
function openRefreshLog() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const log = fs.openSync(REFRESH_LOG, 'a');
        fs.writeSync(log, `\n=== ${new Date().toISOString()} background refresh ===\n`);
        return log;
    } catch (error) {
        console.error(`Cannot open ${REFRESH_LOG} (${error.message}); background refresh output will be discarded.`);
        return null;
    }
}
function stale() {
    const meta = readJsonSafe(META);
    if (!meta) return true;
    if (meta.schemaVersion !== CATALOG_SCHEMA_VERSION) return true;
    // A missing or unparseable builtAt yields NaN, and every NaN comparison is false — which used
    // to mean "fresh forever", so a corrupted meta.json silently froze the catalog. Treat an
    // unreadable timestamp as stale instead.
    const builtAt = Date.parse(meta.builtAt);
    if (!Number.isFinite(builtAt)) return true;
    return Date.now() - builtAt > 7 * 24 * 60 * 60 * 1000;
}

// One unparseable line must not sink a whole search, but dropping it without a word hides real
// catalog corruption (a truncated write, a partially synced data dir) behind "no results found",
// so the count is reported. A catalog with lines but no usable rows is a hard failure: silently
// searching zero documents would look like a legitimate "nothing matches your query".
let skippedLines = 0;
const lines = fs.readFileSync(CATALOG, 'utf8').split('\n').filter(Boolean);
const docs = lines.flatMap((line) => {
    try { return [withCatalogMetadata(JSON.parse(line))]; } catch { skippedLines += 1; return []; }
});
if (skippedLines) console.error(`Skipped ${skippedLines} unparseable catalog line(s) in ${CATALOG}; rebuild with build-index.mjs if results look thin.`);
if (!docs.length) throw new Error(`No usable entries in ${CATALOG} (${lines.length} line(s) unusable). Rebuild it with: node ${BUILD}`);

// --- --get: stable-ID lookup for the finalists only ---
if (requested) {
    const values = [...new Set(requested.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))];
    const recordId = (doc) => String(doc.id || `${doc.kind}:${doc.name}`).toLowerCase();
    const byId = new Map(docs.map((doc) => [recordId(doc), doc]));
    const byName = new Map();
    for (const doc of docs) {
        const name = String(doc.name || '').toLowerCase();
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push(doc);
    }
    const selected = new Set();
    for (const value of values) {
        if (byId.has(value)) {
            selected.add(byId.get(value));
            continue;
        }
        const matches = byName.get(value) || [];
        if (matches.length === 1) selected.add(matches[0]);
        else if (matches.length > 1) {
            console.error(`Ambiguous name ${value}: ${matches.map(recordId).join(', ')}. Pass a kind:name ID to --get.`);
        }
    }
    // fulltext is search-only vocabulary; stripping it here keeps --get's output small.
    const matches = docs.filter((doc) => selected.has(doc)).map(({ fulltext, ...doc }) => doc);
    const meta = readJsonSafe(META) || {};
    console.error('# trace: get');
    console.error(`# executedAt: ${new Date().toISOString()}`);
    console.error(`# catalog: schema=${meta.schemaVersion || 1} builtAt=${meta.builtAt || 'unknown'} entries=${meta.total || docs.length}`);
    console.error(`# get: requested[${values.join(',')}] matched[${matches.map(recordId).join(',')}]`);
    console.log(JSON.stringify(matches, null, 2));
    process.exit(0);
}

// Common English stop words are excluded so they don't dilute IDF weighting or clutter matches[].
const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'with']);
// Token charset allows +.#/- (not just [a-z0-9]) so product names like "c++", "asp.net", or
// "ci/cd" survive tokenization instead of being split into meaningless fragments.
// Two fixes from /code-review (ported from the equivalent c3 fix):
//  - no longer drops single-character tokens (a length>1 filter used to reject valid keywords
//    like "r" for the R language, silently zeroing out the whole query);
//  - strips a trailing period so a term at the end of a sentence in prose ("...on Stripe.")
//    still tokenizes the same as the clean query term ("stripe").
const tokenize = (text) => (String(text).toLowerCase().match(/[a-z0-9][a-z0-9+.#/-]*/g) || [])
    .map((token) => token.replace(/\.+$/, ''))
    .filter((token) => !STOP_WORDS.has(token));

// Keyword-derived and task-derived tokens are kept distinguishable for the trace output below,
// then combined for scoring.
const keywordTokens = [...new Set(tokenize(query))];
const taskTokens = [...new Set(tokenize(task))].filter((token) => !keywordTokens.includes(token));
const tokens = [...keywordTokens, ...taskTokens];

const fields = docs.map((doc) => ({
    name: new Set(tokenize(doc.name)),
    tags: new Set(tokenize((doc.tags || []).join(' '))),
    description: new Set(tokenize(doc.description)),
    // fulltext: SKILL.md / plugin manifest body, present only for some sources. Catches vocabulary
    // (specific API names, file formats) that never makes it into the short description.
    body: new Set(tokenize(doc.fulltext || '')),
}));

// Document frequency computed only for the tokens actually being scored (not the whole corpus
// vocabulary) — cheaper, and it's all idf() below needs. Ubiquitous words (e.g. "code", "ai")
// end up with a low idf and contribute little; rare, specific words (e.g. "stripe") dominate.
const frequency = new Map(tokens.map((token) => [token, fields.reduce((count, field) => count + Number(Object.values(field).some((set) => set.has(token))), 0)]));
const idf = (token) => Math.log(1 + docs.length / (1 + (frequency.get(token) || 0)));

// Field weights: a name hit outweighs a tag hit, which outweighs a description hit, which
// outweighs a body hit. matches[] records which field each token hit — surfaced in the output
// table so a human (or the calling model) can see why a result ranked where it did.
let scored = docs.map((doc, index) => {
    const field = fields[index];
    const matches = [];
    let score = 0;
    for (const token of tokens) {
        const weight = field.name.has(token) ? 3 : field.tags.has(token) ? 2 : field.description.has(token) ? 1 : field.body.has(token) ? 0.5 : 0;
        if (weight) {
            score += weight * idf(token);
            matches.push(`${token}:${weight === 3 ? 'name' : weight === 2 ? 'tag' : weight === 1 ? 'description' : 'body'}`);
        }
    }
    return { doc, score, matches };
}).filter((result) => result.score > 0).sort((a, b) => b.score - a.score);

// --- Optional vector search (--vectors install + API key set + vectors.bin present) fused via RRF ---
// Lets synonym/paraphrase matches surface even when they score zero lexically. Any failure here
// (missing key, dimension mismatch after a catalog rebuild, network error) falls back to
// lexical-only results rather than failing the whole search.
const config = loadConfig();
const provider = resolveProvider(config);
let mode = config.fulltext === false ? 'lexical(lite)' : 'lexical+fulltext';
const vector = provider && !provider.missingKey ? readVectors(docs.length) : null;
if (vector) {
    try {
        const [queryVector] = await embedTexts([task || query], provider);
        if (queryVector.length !== vector.meta.dims) throw new Error(`stored vectors have ${vector.meta.dims} dims but ${provider.name}/${provider.model} produced ${queryVector.length}; rebuild the catalog`);
        const semantic = docs.map((_, i) => {
            let score = 0;
            for (let j = 0; j < vector.meta.dims; j += 1) score += vector.data[i * vector.meta.dims + j] * queryVector[j];
            return { i, score };
        }).sort((a, b) => b.score - a.score);
        // matches lookup is built from the FULL scored array (before slicing to the top 100), so a
        // doc that matched lexically outside the top 100 doesn't lose its matched_fields evidence
        // just because RRF fusion only seeds from the top slice. (/code-review, ported from c3)
        const matchesByDoc = new Map(scored.map((row) => [row.doc, row.matches]));
        // RRF: score = sum of 1/(60+rank) across ranking lists. 60 is the standard RRF constant.
        // fused stays a plain score map (not a cloned row object per entry) — matches are merged
        // back in once, below, instead of being spread into every fusion step.
        const fused = new Map();
        scored.slice(0, 100).forEach((row, i) => fused.set(row.doc, 1 / (60 + i)));
        semantic.slice(0, 100).forEach((row, i) => {
            fused.set(docs[row.i], (fused.get(docs[row.i]) || 0) + 1 / (60 + i));
        });
        scored = [...fused.entries()].map(([doc, score]) => ({ doc, score, matches: matchesByDoc.get(doc) || [] }));
        scored.sort((a, b) => b.score - a.score);
        mode += ` + vector RRF(${vector.meta.provider}/${vector.meta.model})`;
    } catch (error) { console.error(`Vector search failed; lexical results retained: ${error.message}`); }
}

// --- --all output: tab-separated shortlist, capped per kind ---
// install commands and raw scores are withheld here on purpose — --get returns those for the
// finalists only, once the model has actually picked them.
//
// The leading `#` lines are a machine-emitted transparency trace: which catalog build, which
// query, how many hits per kind. The calling model is expected to transcribe these verbatim
// rather than paraphrase them, so the recommendation's rationale is backed by real output and
// not a self-report.
const caps = { skill: 6, plugin: 5, mcp: 5 };
const byKind = new Map();
for (const row of scored) {
    if (!byKind.has(row.doc.kind)) byKind.set(row.doc.kind, []);
    byKind.get(row.doc.kind).push(row);
}

const meta = readJsonSafe(META) || {};
const executedAt = new Date().toISOString();

console.log('# trace: search');
console.log(`# executedAt: ${executedAt}`);
console.log(`# catalog: schema=${meta.schemaVersion || 1} builtAt=${meta.builtAt || 'unknown'} entries=${meta.total || docs.length}`);
console.log(`# mode: ${mode}`);
console.log(`# query: keywords[${keywordTokens.join(' ')}]${taskTokens.length ? ` + task[${taskTokens.join(' ')}]` : ''}`);
console.log(`# hits: ${Object.keys(caps).map((kind) => `${kind} matched=${(byKind.get(kind) || []).length} returned=${Math.min(caps[kind], (byKind.get(kind) || []).length)}`).join(' / ')}`);
console.log('id\tkind\tname\tsource\tmatched_fields\tdescription');
for (const kind of Object.keys(caps)) {
    for (const row of (byKind.get(kind) || []).slice(0, caps[kind])) {
        console.log(`${row.doc.id || `${row.doc.kind}:${row.doc.name}`}\t${row.doc.kind}\t${row.doc.name}\t${row.doc.source}\t${row.matches.join(',')}\t${(row.doc.description || '').replace(/[\t\n]/g, ' ').slice(0, 110)}`);
    }
}
