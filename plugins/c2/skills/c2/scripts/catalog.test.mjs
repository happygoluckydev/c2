// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOG_SCHEMA_VERSION, inferSourceClass, metadataWarnings, resolveCatalogRecords, withCatalogMetadata } from './catalog.mjs';

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
    assert.equal(fromPackaging.availability, 'unknown');
    assert.equal(fromPackaging.packaging, 'plugin');

    const standalone = withCatalogMetadata({
        kind: 'skill', name: 'standalone', source: 'remote', distribution: 'standalone',
    });
    assert.equal(standalone.availability, 'unknown');
    assert.equal(standalone.packaging, 'standalone');

    const builtIn = withCatalogMetadata({
        kind: 'skill', name: 'built-in', source: 'core', distribution: 'built-in',
    });
    assert.equal(builtIn.availability, 'built-in');
    assert.equal(builtIn.packaging, 'built-in');

    const builtinAlias = withCatalogMetadata({
        kind: 'skill', name: 'builtin', source: 'core', distribution: 'builtin',
    });
    assert.equal(builtinAlias.availability, 'unknown');
    assert.equal(builtinAlias.packaging, 'built-in');

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

test('enum metadata is normalized before validation', () => {
    const entry = withCatalogMetadata({
        kind: 'skill', name: 'Example', source: 'installed',
        availability: ' Installed ', packaging: 'Plugin', execution: 'Prompt',
        maturity: 'Stable', sourceClass: 'Community',
    });
    assert.equal(entry.availability, 'installed');
    assert.equal(entry.packaging, 'plugin');
    assert.equal(entry.execution, 'prompt');
    assert.equal(entry.maturity, 'stable');
    assert.equal(entry.sourceClass, 'community');
});

test('rejected non-empty enum values are recorded as warnings', () => {
    const before = metadataWarnings.length;
    const entry = withCatalogMetadata({
        kind: 'skill', name: 'Example', source: 'unknown',
        availability: 'not-real',
    });
    assert.equal(entry.availability, 'unknown');
    assert.ok(metadataWarnings.slice(before).includes('availability=not-real'));
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

test('resolver accepts IDs, unique bare names, and reports unresolved values', () => {
    const docs = [
        withCatalogMetadata({ kind: 'skill', name: 'alpha', source: 'one' }),
        withCatalogMetadata({ kind: 'skill', name: 'shared', source: 'one' }),
        withCatalogMetadata({ kind: 'plugin', name: 'shared', source: 'two' }),
        withCatalogMetadata({ kind: 'skill', name: 'foo, bar', source: 'one' }),
    ];
    const result = resolveCatalogRecords(docs, ['skill:alpha,missing', 'shared', 'skill:foo, bar']);
    assert.deepEqual(result.records.map((entry) => entry.id), ['skill:alpha', 'skill:foo, bar']);
    assert.deepEqual(result.missing, ['missing']);
    assert.deepEqual(result.ambiguous, ['shared']);
    assert.deepEqual(result.fallback, ['skill:foo, bar']);
});

test('resolver accepts repeated get values for comma-containing names', () => {
    const docs = [withCatalogMetadata({ kind: 'skill', name: 'foo, bar', source: 'one' })];
    const result = resolveCatalogRecords(docs, ['skill:foo, bar']);
    assert.equal(result.records[0].name, 'foo, bar');
    assert.deepEqual(result.fallback, ['skill:foo, bar']);
});
