// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import test from 'node:test';
import { inferSourceClass, withCatalogMetadata } from './catalog.mjs';

test('installation state does not overwrite publisher provenance', () => {
    const entry = withCatalogMetadata({ kind: 'skill', name: 'example', source: 'installed-plugin', distribution: 'installed' });
    assert.equal(entry.sourceClass, 'unknown');
    assert.equal(entry.distribution, 'installed');
});

test('only known publisher sources receive a provenance classification', () => {
    assert.equal(inferSourceClass('openai/skills'), 'official');
    assert.equal(inferSourceClass('VoltAgent/awesome-agent-skills'), 'community');
    assert.equal(inferSourceClass('MCP Registry'), 'unknown');
});
