// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CATALOG_SCHEMA_VERSION, entryId, inferSourceClass, kindName, readFrontmatterFile, withCatalogMetadata } from './catalog.mjs';

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

test('only known publisher sources receive a provenance classification', () => {
    assert.equal(inferSourceClass('openai/skills'), 'official');
    assert.equal(inferSourceClass('VoltAgent/awesome-agent-skills'), 'community');
    assert.equal(inferSourceClass('MCP Registry'), 'unknown');
});

test('entry IDs prefer explicit IDs and derive kind/name IDs', () => {
    assert.equal(entryId({ id: 'custom', kind: 'skill', name: 'Example' }), 'custom');
    assert.equal(entryId({ kind: 'skill', name: 'Example' }), 'skill:Example');
    assert.equal(kindName({ id: 'custom', kind: 'plugin', name: 'Demo' }), 'plugin:Demo');
});

test('readFrontmatterFile parses a frontmatter fixture', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-catalog-test-'));
    const file = path.join(directory, 'SKILL.md');
    try {
        fs.writeFileSync(file, '---\nname: Fixture\ndescription: A test fixture\n---\nBody text\n');
        const result = readFrontmatterFile(file);
        assert.equal(result.name, 'Fixture');
        assert.equal(result.description, 'A test fixture');
        assert.equal(result.body, 'Body text');
        assert.ok(result.fmLen > 0);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
