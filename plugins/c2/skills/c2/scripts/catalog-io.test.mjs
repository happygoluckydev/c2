// SPDX-License-Identifier: MIT
// Tests for catalog.mjs's filesystem, config, and embedding helpers.
// CODEX_HOME is redirected before the module is imported, because catalog.mjs resolves its path
// constants at import time.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox, writeFile } from './test-helpers.mjs';

const { dataDir } = sandbox('catalog-io');
process.env.CODEX_HOME = path.dirname(dataDir);
const {
    CATALOG, DATA_DIR, VEC_BIN, VEC_META,
    clipped, embedTexts, loadConfig, parseFrontmatter, readJsonSafe, readVectors,
    resolveProvider, walk, writeAtomic, writeVectors,
} = await import('./catalog.mjs');

const captureStderr = async (run) => {
    const original = console.error;
    const lines = [];
    console.error = (...args) => lines.push(args.join(' '));
    try { return { result: await run(), lines }; } finally { console.error = original; }
};

test('path constants follow CODEX_HOME', () => {
    assert.equal(DATA_DIR, dataDir);
    assert.equal(CATALOG, path.join(dataDir, 'catalog.jsonl'));
});

test('parseFrontmatter reads name and description and measures the frontmatter length', () => {
    const text = '---\nname: demo\ndescription: "does a thing"\nother: ignored\n---\n\nbody text\n';
    const fm = parseFrontmatter(text);
    assert.equal(fm.name, 'demo');
    assert.equal(fm.description, 'does a thing');
    assert.equal(fm.body, 'body text');
    assert.equal(fm.fmLen, text.indexOf('---\n\nbody') + 3);
    assert.equal('other' in fm, false);
});

test('parseFrontmatter handles CRLF documents and single quotes', () => {
    const fm = parseFrontmatter("---\r\nname: 'demo'\r\ndescription: quoted\r\n---\r\nbody\r\n");
    assert.equal(fm.name, 'demo');
    assert.equal(fm.description, 'quoted');
    assert.equal(fm.body, 'body');
});

test('parseFrontmatter treats a document without frontmatter as pure body', () => {
    const fm = parseFrontmatter('  # just markdown  ');
    assert.deepEqual(fm, { fmLen: 0, body: '# just markdown' });
});

test('clipped drops NUL bytes and caps the body at 4000 characters', () => {
    assert.equal(clipped(), '');
    assert.equal(clipped('a\0b'), 'ab');
    assert.equal(clipped('x'.repeat(4100)).length, 4000);
});

test('walk collects matching files and skips .git and node_modules', () => {
    const { home } = sandbox('walk');
    writeFile(path.join(home, 'a', 'SKILL.md'), 'a');
    writeFile(path.join(home, 'a', 'b', 'SKILL.md'), 'b');
    writeFile(path.join(home, 'a', 'notes.txt'), 'skip');
    writeFile(path.join(home, '.git', 'SKILL.md'), 'skip');
    writeFile(path.join(home, 'node_modules', 'pkg', 'SKILL.md'), 'skip');

    const found = walk(home, (file) => path.basename(file) === 'SKILL.md').sort();
    assert.deepEqual(found, [path.join(home, 'a', 'SKILL.md'), path.join(home, 'a', 'b', 'SKILL.md')].sort());
    assert.deepEqual(walk(path.join(home, 'missing'), () => true), []);
});

test('writeAtomic replaces the target and leaves no temporary file behind', () => {
    const file = path.join(dataDir, 'atomic.txt');
    writeAtomic(file, 'first');
    writeAtomic(file, 'second');
    assert.equal(fs.readFileSync(file, 'utf8'), 'second');
    assert.deepEqual(fs.readdirSync(dataDir).filter((name) => name.includes('.tmp')), []);
});

test('readJsonSafe parses valid JSON, stays silent on a missing file, and reports corruption', async () => {
    const valid = writeFile(path.join(dataDir, 'valid.json'), '{"a":1}');
    const broken = writeFile(path.join(dataDir, 'broken.json'), '{not json');

    assert.deepEqual(readJsonSafe(valid), { a: 1 });

    const missing = await captureStderr(() => readJsonSafe(path.join(dataDir, 'nope.json')));
    assert.equal(missing.result, null);
    assert.deepEqual(missing.lines, []);

    const corrupt = await captureStderr(() => readJsonSafe(broken));
    assert.equal(corrupt.result, null);
    assert.equal(corrupt.lines.length, 1);
    assert.match(corrupt.lines[0], /ignoring invalid JSON/);
});

test('loadConfig returns defaults and merges config.json on top of them', () => {
    const config = path.join(dataDir, 'config.json');
    fs.rmSync(config, { force: true });
    assert.deepEqual(loadConfig(), { fulltext: true, vectors: { provider: 'none' } });

    fs.writeFileSync(config, JSON.stringify({ fulltext: false }));
    assert.deepEqual(loadConfig(), { fulltext: false, vectors: { provider: 'none' } });
    fs.rmSync(config, { force: true });
});

test('resolveProvider disables vectors when unset or "none"', () => {
    assert.equal(resolveProvider({}), null);
    assert.equal(resolveProvider({ vectors: { provider: 'none' } }), null);
});

test('resolveProvider rejects an unknown provider name', () => {
    assert.throws(() => resolveProvider({ vectors: { provider: 'nope' } }), /Unknown vector provider: nope/);
});

test('resolveProvider reports the missing key env instead of throwing', (t) => {
    t.after(() => { delete process.env.VOYAGE_API_KEY; delete process.env.CUSTOM_KEY; });
    delete process.env.VOYAGE_API_KEY;
    assert.deepEqual(resolveProvider({ vectors: { provider: 'voyage' } }), { name: 'voyage', missingKey: 'VOYAGE_API_KEY' });
    assert.deepEqual(
        resolveProvider({ vectors: { provider: 'voyage', apiKeyEnv: 'CUSTOM_KEY' } }),
        { name: 'voyage', missingKey: 'CUSTOM_KEY' },
    );
});

test('resolveProvider fills in the provider defaults and honours a model override', (t) => {
    t.after(() => { delete process.env.OPENAI_API_KEY; });
    process.env.OPENAI_API_KEY = 'k';
    const provider = resolveProvider({ vectors: { provider: 'openai' } });
    assert.equal(provider.model, 'text-embedding-3-small');
    assert.equal(provider.batch, 256);
    assert.equal(provider.key, 'k');

    const [url, headers, body] = provider.request(['hello'], provider);
    assert.equal(url, 'https://api.openai.com/v1/embeddings');
    assert.deepEqual(headers, { Authorization: 'Bearer k' });
    assert.deepEqual(body, { model: 'text-embedding-3-small', input: ['hello'] });
    assert.deepEqual(provider.extract({ data: [{ embedding: [1, 2] }] }), [[1, 2]]);

    assert.equal(resolveProvider({ vectors: { provider: 'openai', model: 'custom' } }).model, 'custom');
});

test('the gemini provider uses its own request and response shape', (t) => {
    t.after(() => { delete process.env.GEMINI_API_KEY; });
    process.env.GEMINI_API_KEY = 'g';
    const provider = resolveProvider({ vectors: { provider: 'gemini' } });
    const [url, headers, body] = provider.request(['hi'], provider);
    assert.match(url, /batchEmbedContents\?key=g$/);
    assert.deepEqual(headers, {});
    assert.deepEqual(body.requests[0].content.parts, [{ text: 'hi' }]);
    assert.deepEqual(provider.extract({ embeddings: [{ values: [0, 1] }] }), [[0, 1]]);
});

test('embedTexts batches requests and L2-normalizes every vector', async () => {
    const seen = [];
    const provider = {
        batch: 2,
        request: (input) => ['https://example.invalid/embed', {}, { input }],
        extract: (body) => body.vectors,
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        seen.push(body.input);
        return { ok: true, json: async () => ({ vectors: body.input.map(() => [3, 4]) }) };
    };
    try {
        const vectors = await embedTexts(['a', 'b', 'c'], provider);
        assert.deepEqual(seen, [['a', 'b'], ['c']]);
        assert.equal(vectors.length, 3);
        for (const vector of vectors) assert.deepEqual(vector, [0.6, 0.8]);
    } finally { globalThis.fetch = originalFetch; }
});

test('embedTexts surfaces a non-2xx embedding response', async () => {
    const provider = { batch: 8, request: (input) => ['https://example.invalid/embed', {}, { input }], extract: (body) => body.vectors };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => 'slow down' });
    try {
        await assert.rejects(() => embedTexts(['a'], provider), /Embedding API HTTP 429: slow down/);
    } finally { globalThis.fetch = originalFetch; }
});

test('writeVectors and readVectors round-trip a catalog-sized matrix', () => {
    writeVectors([[1, 0], [0, 1]], { provider: 'openai', model: 'text-embedding-3-small' });
    const stored = readVectors(2);
    assert.equal(stored.meta.dims, 2);
    assert.equal(stored.meta.count, 2);
    assert.equal(stored.meta.provider, 'openai');
    assert.deepEqual([...stored.data], [1, 0, 0, 1]);
    assert.deepEqual([...readVectors(null).data], [1, 0, 0, 1]);
});

test('readVectors rejects vectors that no longer match the catalog', () => {
    writeVectors([[1, 0], [0, 1]], { provider: 'openai', model: 'm' });
    assert.equal(readVectors(3), null);
});

test('readVectors rejects a truncated vectors.bin without reading it', async () => {
    writeVectors([[1, 0], [0, 1]], { provider: 'openai', model: 'm' });
    fs.writeFileSync(VEC_BIN, Buffer.alloc(4));
    assert.equal(readVectors(2), null);
});

test('readVectors returns null when the sidecar metadata is missing or empty', async () => {
    fs.rmSync(VEC_META, { force: true });
    assert.equal(readVectors(2), null);

    fs.writeFileSync(VEC_META, JSON.stringify({ dims: 0, count: 0 }));
    assert.equal(readVectors(0), null);

    fs.writeFileSync(VEC_META, JSON.stringify({ dims: 2, count: 1 }));
    fs.rmSync(VEC_BIN, { force: true });
    const missingBin = await captureStderr(() => readVectors(1));
    assert.equal(missingBin.result, null);
    assert.deepEqual(missingBin.lines, []);
});
