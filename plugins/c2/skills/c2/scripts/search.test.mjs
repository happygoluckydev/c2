// SPDX-License-Identifier: MIT
// Tests for search.mjs. It is a CLI entry point, so each case runs it as a child process against a
// throwaway CODEX_HOME holding a fixture catalog.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runScript, sandbox, stubFetch } from './test-helpers.mjs';

const entry = (over) => ({
    kind: 'skill', name: 'entry', description: '', source: 'installed',
    availability: 'installed', packaging: 'standalone', execution: 'prompt', ...over,
});

const FIXTURE = [
    entry({ name: 'stripe-invoice', description: 'create invoices', tags: ['billing'], fulltext: 'webhook signature verification' }),
    entry({ name: 'pdf-export', description: 'render documents as pdf', tags: ['pdf'] }),
    entry({ name: 'duplicate', description: 'a skill named duplicate' }),
    entry({ kind: 'mcp', name: 'duplicate', description: 'an mcp named duplicate', source: 'MCP Registry', install: 'codex mcp add <name> --url https://example.com' }),
    entry({ kind: 'plugin', name: 'billing-plugin', description: 'billing helpers', source: 'installed', tags: ['billing'] }),
    ...Array.from({ length: 8 }, (_, i) => entry({ name: `filler-${i}`, description: 'billing filler skill' })),
    ...Array.from({ length: 6 }, (_, i) => entry({ kind: 'plugin', name: `filler-plugin-${i}`, description: 'billing filler plugin', source: 'installed' })),
    ...Array.from({ length: 6 }, (_, i) => entry({ kind: 'mcp', name: `filler-mcp-${i}`, description: 'billing filler mcp', source: 'MCP Registry' })),
];

function catalogSandbox({ builtAt = new Date().toISOString(), schemaVersion = 3, docs = FIXTURE, config } = {}) {
    const box = sandbox('search');
    const lines = docs.map((doc) => JSON.stringify(doc));
    // A blank line and an unparseable line: search.mjs must skip both instead of failing the query.
    fs.writeFileSync(path.join(box.dataDir, 'catalog.jsonl'), `${lines.join('\n')}\n\n{not json\n`);
    fs.writeFileSync(path.join(box.dataDir, 'meta.json'), JSON.stringify({ schemaVersion, builtAt, total: docs.length }));
    if (config) fs.writeFileSync(path.join(box.dataDir, 'config.json'), JSON.stringify(config));
    return box;
}

// A synchronous catalog build inherits stdout, so results are read from the trace header onwards.
const rows = (stdout) => stdout.slice(stdout.indexOf('# trace: search')).split('\n')
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('id\t'))
    .map((line) => line.split('\t'));
const traceLine = (stdout, prefix) => stdout.split('\n').find((line) => line.startsWith(prefix));

test('search requires --all or --get', () => {
    const result = runScript('search.mjs', [], catalogSandbox());
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage: --all "keywords"/);
});

test('--get before any catalog exists explains what to run first', () => {
    const box = sandbox('search-empty');
    const result = runScript('search.mjs', ['--get', 'skill:stripe-invoice'], box);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No catalog yet\. Run a --all search first\./);
});

test('--all builds the catalog synchronously when none exists yet', () => {
    const box = sandbox('search-build');
    const skill = path.join(box.codexHome, 'skills', 'local-skill');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: local-skill\ndescription: billing helper\n---\n\nbody\n');

    const result = runScript('search.mjs', ['--all', 'billing'], box, stubFetch(box.home));
    assert.equal(result.status, 0);
    assert.match(result.stderr, /Catalog missing — building it now \(HTTP only, no model call\)\./);
    assert.ok(fs.existsSync(path.join(box.dataDir, 'catalog.jsonl')));
    assert.deepEqual(rows(result.stdout).map((row) => row[2]), ['local-skill']);
});

test('--all emits the trace header, column header, and per-kind caps', () => {
    const box = catalogSandbox();
    const { builtAt } = JSON.parse(fs.readFileSync(path.join(box.dataDir, 'meta.json'), 'utf8'));
    const result = runScript('search.mjs', ['--all', 'billing'], box);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^# trace: search\n/);
    assert.equal(traceLine(result.stdout, '# catalog:'), `# catalog: schema=3 builtAt=${builtAt} entries=${FIXTURE.length}`);
    assert.equal(traceLine(result.stdout, '# mode:'), '# mode: lexical+fulltext');
    assert.equal(traceLine(result.stdout, '# query:'), '# query: keywords[billing]');
    assert.match(traceLine(result.stdout, '# hits:'), /skill matched=\d+ returned=6 \/ plugin matched=\d+ returned=5 \/ mcp matched=\d+ returned=5/);
    assert.ok(result.stdout.includes('id\tkind\tname\tsource\tmatched_fields\tdescription'));

    const kinds = rows(result.stdout).map((row) => row[1]);
    assert.equal(kinds.filter((kind) => kind === 'skill').length, 6);
    assert.equal(kinds.filter((kind) => kind === 'plugin').length, 5);
    assert.equal(kinds.filter((kind) => kind === 'mcp').length, 5);
    // Kinds are emitted in a stable skill -> plugin -> mcp order.
    assert.deepEqual([...new Set(kinds)], ['skill', 'plugin', 'mcp']);
});

test('--all reports which field each token matched', () => {
    const result = runScript('search.mjs', ['--all', 'pdf-export pdf webhook billing'], catalogSandbox());
    const byName = new Map(rows(result.stdout).map((row) => [row[2], row]));
    // Hyphenated terms stay one token, so bare "pdf" matches the tag rather than the name.
    assert.equal(byName.get('pdf-export')[4], 'pdf-export:name,pdf:tag');
    assert.equal(byName.get('stripe-invoice')[4], 'webhook:body,billing:tag');
    assert.equal(byName.get('billing-plugin')[4], 'billing:tag');
});

test('--all ranks a tag hit above a description-only hit', () => {
    const result = runScript('search.mjs', ['--all', 'billing'], catalogSandbox());
    const skills = rows(result.stdout).filter((row) => row[1] === 'skill').map((row) => row[2]);
    const plugins = rows(result.stdout).filter((row) => row[1] === 'plugin').map((row) => row[2]);
    assert.equal(plugins[0], 'billing-plugin');
    assert.equal(skills[0], 'stripe-invoice');
});

test('--task tokens supplement the keywords and are traced separately', () => {
    const result = runScript('search.mjs', ['--all', 'billing', '--task', 'Send an invoice on Stripe. billing'], catalogSandbox());
    assert.equal(traceLine(result.stdout, '# query:'), '# query: keywords[billing] + task[send invoice stripe]');
    assert.ok(rows(result.stdout).some((row) => row[2] === 'stripe-invoice'));
});

test('--all returns no rows when nothing matches', () => {
    const result = runScript('search.mjs', ['--all', 'zzzznomatch'], catalogSandbox());
    assert.equal(result.status, 0);
    assert.deepEqual(rows(result.stdout), []);
    assert.match(traceLine(result.stdout, '# hits:'), /skill matched=0 returned=0/);
});

test('--get returns full records by stable id and strips search-only fulltext', () => {
    const result = runScript('search.mjs', ['--get', 'SKILL:stripe-invoice'], catalogSandbox());
    assert.equal(result.status, 0);
    const [record, ...rest] = JSON.parse(result.stdout);
    assert.equal(rest.length, 0);
    assert.equal(record.id, 'skill:stripe-invoice');
    assert.equal('fulltext' in record, false);
    assert.match(result.stderr, /# trace: get/);
    assert.match(result.stderr, /# get: requested\[skill:stripe-invoice\] matched\[skill:stripe-invoice\]/);
});

test('--get accepts a bare name only when it is unique, and dedupes repeated requests', () => {
    const result = runScript('search.mjs', ['--get', 'pdf-export,pdf-export,skill:stripe-invoice'], catalogSandbox());
    assert.deepEqual(JSON.parse(result.stdout).map((doc) => doc.id), ['skill:stripe-invoice', 'skill:pdf-export']);
    assert.match(result.stderr, /# get: requested\[pdf-export,skill:stripe-invoice\]/);
});

test('--get refuses an ambiguous bare name and asks for a kind:name id', () => {
    const result = runScript('search.mjs', ['--get', 'duplicate'], catalogSandbox());
    assert.deepEqual(JSON.parse(result.stdout), []);
    assert.match(result.stderr, /Ambiguous name duplicate: skill:duplicate, mcp:duplicate\. Pass a kind:name ID to --get\./);

    const resolved = runScript('search.mjs', ['--get', 'mcp:duplicate'], catalogSandbox());
    assert.deepEqual(JSON.parse(resolved.stdout).map((doc) => doc.id), ['mcp:duplicate']);
});

test('--get ignores unknown ids', () => {
    const result = runScript('search.mjs', ['--get', 'skill:nope'], catalogSandbox());
    assert.deepEqual(JSON.parse(result.stdout), []);
    assert.match(result.stderr, /matched\[\]/);
});

test('a stale catalog is served immediately while a rebuild is triggered', () => {
    const box = catalogSandbox({ builtAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() });
    const result = runScript('search.mjs', ['--all', 'billing'], box, stubFetch(box.home));
    assert.equal(result.status, 0);
    assert.match(result.stderr, /Catalog is stale — serving it now and refreshing in the background\./);
    assert.ok(rows(result.stdout).length > 0);
});

test('a catalog built by a different schema version counts as stale', () => {
    const box = catalogSandbox({ schemaVersion: 2 });
    const result = runScript('search.mjs', ['--all', 'billing'], box, stubFetch(box.home));
    assert.match(result.stderr, /Catalog is stale/);
});

test('a missing meta.json counts as stale and the trace falls back to schema=1', () => {
    const box = catalogSandbox();
    fs.rmSync(path.join(box.dataDir, 'meta.json'));
    const result = runScript('search.mjs', ['--all', 'billing'], box, stubFetch(box.home));
    assert.match(result.stderr, /Catalog is stale/);
    assert.equal(traceLine(result.stdout, '# catalog:'), `# catalog: schema=1 builtAt=unknown entries=${FIXTURE.length}`);
});

test('lite mode is reported in the trace', () => {
    const box = catalogSandbox({ config: { fulltext: false } });
    const result = runScript('search.mjs', ['--all', 'billing'], box);
    assert.equal(traceLine(result.stdout, '# mode:'), '# mode: lexical(lite)');
});

test('a configured provider without its API key stays lexical', () => {
    const box = catalogSandbox({ config: { vectors: { provider: 'openai' } } });
    const result = runScript('search.mjs', ['--all', 'billing'], box, { OPENAI_API_KEY: '' });
    assert.equal(traceLine(result.stdout, '# mode:'), '# mode: lexical+fulltext');
});

function writeVectorFixture(box, { dims, count, provider = 'openai', model = 'text-embedding-3-small' }) {
    const data = new Float32Array(dims * count);
    for (let i = 0; i < count; i += 1) data[i * dims + (i % dims)] = 1;
    fs.writeFileSync(path.join(box.dataDir, 'vectors.bin'), Buffer.from(data.buffer));
    fs.writeFileSync(path.join(box.dataDir, 'vectors.json'), JSON.stringify({ provider, model, dims, count }));
}

test('vector search fuses with the lexical ranking when vectors and a key are present', () => {
    const box = catalogSandbox({ config: { vectors: { provider: 'openai' } } });
    writeVectorFixture(box, { dims: 4, count: FIXTURE.length });
    const result = runScript('search.mjs', ['--all', 'billing'], box, {
        OPENAI_API_KEY: 'k',
        ...stubFetch(box.home, [{ match: '/embeddings', embed: 4 }]),
    });
    assert.equal(result.status, 0);
    assert.equal(traceLine(result.stdout, '# mode:'), '# mode: lexical+fulltext + vector RRF(openai/text-embedding-3-small)');
    // Fusion can surface docs with no lexical hit; those rows carry an empty matched_fields cell.
    assert.ok(rows(result.stdout).length > 0);
});

test('a dimension mismatch keeps the lexical results and warns', () => {
    const box = catalogSandbox({ config: { vectors: { provider: 'openai' } } });
    writeVectorFixture(box, { dims: 4, count: FIXTURE.length });
    const result = runScript('search.mjs', ['--all', 'billing'], box, {
        OPENAI_API_KEY: 'k',
        ...stubFetch(box.home, [{ match: '/embeddings', embed: 3 }]),
    });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /Vector search failed; lexical results retained: stored vectors have 4 dims but openai\/text-embedding-3-small produced 3/);
    assert.ok(rows(result.stdout).some((row) => row[2] === 'billing-plugin'));
});

test('vectors that do not match the catalog row count are ignored', () => {
    const box = catalogSandbox({ config: { vectors: { provider: 'openai' } } });
    writeVectorFixture(box, { dims: 4, count: 2 });
    const result = runScript('search.mjs', ['--all', 'billing'], box, {
        OPENAI_API_KEY: 'k',
        ...stubFetch(box.home),
    });
    assert.equal(traceLine(result.stdout, '# mode:'), '# mode: lexical+fulltext');
});
