// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOG_SCHEMA_VERSION, inferSourceClass, withCatalogMetadata } from './catalog.mjs';

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

test('an unrecognized legacy distribution degrades to unknown metadata', () => {
    const entry = withCatalogMetadata({ kind: 'skill', name: 'legacy', source: 'unknown', distribution: 'sideloaded' });
    assert.equal(entry.availability, 'unknown');
    assert.equal(entry.packaging, 'unknown');
    assert.equal(entry.maturity, 'unknown');
    assert.deepEqual(entry.surface, ['unknown']);
    assert.deepEqual(entry.permissions, ['unknown']);
});

test('execution aliases are expanded and unknown values are not invented', () => {
    assert.equal(withCatalogMetadata({ kind: 'skill', name: 'a', execution: 'agent' }).execution, 'isolated-agent');
    assert.equal(withCatalogMetadata({ kind: 'skill', name: 'a', execution: 'background' }).execution, 'background-monitor');
    assert.equal(withCatalogMetadata({ kind: 'skill', name: 'a', execution: 'deterministic' }).execution, 'deterministic-hook');
    assert.equal(withCatalogMetadata({ kind: 'skill', name: 'a', execution: 'telepathy' }).execution, 'unknown');
});

test('surface and permissions lists are deduplicated and trimmed', () => {
    const entry = withCatalogMetadata({ kind: 'skill', name: 'a', surface: ' cli ', permissions: ['network', 'network', ' '] });
    assert.deepEqual(entry.surface, ['cli']);
    assert.deepEqual(entry.permissions, ['network']);
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
