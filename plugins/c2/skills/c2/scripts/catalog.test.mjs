// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CATALOG_SCHEMA_VERSION, inferSourceClass, walk, withCatalogMetadata, writeAtomic } from './catalog.mjs';

const REQUIRED = [
    'id', 'platform', 'kind', 'name', 'description', 'source', 'availability', 'packaging',
    'domain', 'execution', 'sourceClass', 'license', 'maturity', 'surface', 'parentPlugin', 'permissions',
];

test('schema version matches the shared contract', () => {
    assert.equal(CATALOG_SCHEMA_VERSION, 3);
});

test('availability and packaging stay independent; distribution is stripped', () => {
    const fromAvailability = withCatalogMetadata({
        kind: 'skill', name: 'example', source: 'installed-plugin', distribution: 'installed',
    });
    assert.equal(fromAvailability.sourceClass, 'unknown');
    assert.equal(fromAvailability.availability, 'installed');
    assert.equal(fromAvailability.packaging, 'unknown');
    assert.equal('distribution' in fromAvailability, false);

    const fromPackaging = withCatalogMetadata({
        kind: 'plugin', name: 'demo', source: 'marketplace:personal', distribution: 'plugin',
    });
    assert.equal(fromPackaging.availability, 'installable');
    assert.equal(fromPackaging.packaging, 'plugin');

    const explicit = withCatalogMetadata({
        kind: 'mcp', name: 'demo', source: 'MCP Registry',
        availability: 'installable', packaging: 'standalone', execution: 'external-service',
        install: 'codex mcp add <name> --url https://example.com',
    });
    assert.equal(explicit.availability, 'installable');
    assert.equal(explicit.packaging, 'standalone');
    assert.match(explicit.install, /<name>/);
    assert.equal(explicit.install.includes(explicit.name), false);
});

test('normalized entries expose the shared required fields', () => {
    const entry = withCatalogMetadata({
        kind: 'skill', name: 'Example', description: 'demo', source: 'installed',
        availability: 'installed', packaging: 'standalone', execution: 'prompt',
    });
    for (const field of REQUIRED) assert.ok(field in entry, `missing ${field}`);
    assert.equal(entry.id, 'skill:Example');
    assert.equal(entry.platform, 'codex');
});

// --- Error propagation ---

test('writeAtomic reports the failure and leaves no temp file behind', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-write-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    // Renaming onto an existing directory fails, standing in for any write/rename failure.
    const target = path.join(dir, 'catalog.jsonl');
    fs.mkdirSync(target);

    assert.throws(() => writeAtomic(target, 'payload'), /Failed to write .*catalog\.jsonl/);
    assert.deepEqual(fs.readdirSync(dir), ['catalog.jsonl']);
});

test('walk reports an unlistable directory and still returns the rest', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-walk-'));
    t.after(() => {
        fs.chmodSync(path.join(root, 'locked'), 0o700);
        fs.rmSync(root, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(root, 'readable'));
    fs.writeFileSync(path.join(root, 'readable', 'SKILL.md'), '---\nname: ok\n---\nbody');
    fs.mkdirSync(path.join(root, 'locked'));
    fs.writeFileSync(path.join(root, 'locked', 'SKILL.md'), '---\nname: hidden\n---\nbody');
    fs.chmodSync(path.join(root, 'locked'), 0o000);

    const failures = [];
    const files = walk(root, (file) => path.basename(file) === 'SKILL.md', (dir, error) => failures.push([dir, error]));
    assert.deepEqual(files, [path.join(root, 'readable', 'SKILL.md')]);
    assert.equal(failures.length, 1);
    assert.equal(failures[0][0], path.join(root, 'locked'));
    assert.ok(failures[0][1] instanceof Error);
});

test('only known publisher sources receive a provenance classification', () => {
    assert.equal(inferSourceClass('openai/skills'), 'official');
    assert.equal(inferSourceClass('VoltAgent/awesome-agent-skills'), 'community');
    assert.equal(inferSourceClass('MCP Registry'), 'unknown');
});
