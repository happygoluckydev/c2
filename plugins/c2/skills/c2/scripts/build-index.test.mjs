// SPDX-License-Identifier: MIT
// Tests for build-index.mjs. The crawler is a CLI entry point that talks to five public sources, so
// every case runs it as a child process with a throwaway CODEX_HOME/HOME and a fixture-backed fetch
// (test-fixtures/route-fetch.mjs). Nothing here touches the network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runScript, sandbox, stubFetch, writeFile, writeSkill } from './test-helpers.mjs';

const TREE_URL = 'api.github.com/repos/openai/skills/git/trees';
const ANTHROPIC_TREE_URL = 'api.github.com/repos/anthropics/skills/git/trees';
const RAW = 'raw.githubusercontent.com/openai/skills';
const ANTHROPIC_RAW = 'raw.githubusercontent.com/anthropics/skills';
const VOLTAGENT = 'VoltAgent/awesome-agent-skills/main/README.md';
const TEMPLATES = 'claude-code-templates/main/docs/components.json';
const REGISTRY = 'registry.modelcontextprotocol.io/v0/servers';

const skillFile = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${name} body text\n`;

// Minimal happy-path answers for all five network sources; individual tests override single routes.
function defaultRoutes(overrides = []) {
    return [
        ...overrides,
        { match: TREE_URL, json: { tree: [{ path: 'pdf/SKILL.md' }, { path: 'docs/README.md' }] } },
        { match: `${RAW}/main/pdf/SKILL.md`, text: skillFile('pdf', 'official pdf skill') },
        { match: ANTHROPIC_TREE_URL, json: { tree: [{ path: 'excel/SKILL.md' }] } },
        { match: `${ANTHROPIC_RAW}/main/excel/SKILL.md`, text: skillFile('excel', 'anthropic excel skill') },
        { match: VOLTAGENT, text: '- **[volt-skill](https://example.com/volt)** - a community skill\nnot an entry\n' },
        { match: TEMPLATES, json: { skills: [{ path: 'security/audit', description: 'audit templates', category: 'security', keywords: ['sast'] }] } },
        { match: REGISTRY, json: { servers: [{ server: { name: 'io.example/db', description: 'database access', remotes: [{ url: 'https://mcp.example.com/db' }] } }] } },
    ];
}

function buildSandbox({ installedSkills = [], plugins = [], marketplace, config } = {}) {
    const box = sandbox('build-index');
    for (const skill of installedSkills) writeSkill(path.join(box.codexHome, 'skills', skill.name), skill);
    for (const plugin of plugins) {
        const root = path.join(box.codexHome, 'plugins', plugin.dir);
        writeFile(path.join(root, '.codex-plugin', 'plugin.json'), plugin.manifest);
        for (const skill of plugin.skills || []) writeSkill(path.join(root, 'skills', skill.name), skill);
    }
    if (marketplace !== undefined) writeFile(path.join(box.home, '.agents', 'plugins', 'marketplace.json'), marketplace);
    if (config) writeFile(path.join(box.dataDir, 'config.json'), JSON.stringify(config));
    return box;
}

function build(box, routes = defaultRoutes(), extraEnv = {}) {
    const result = runScript('build-index.mjs', [], box, { ...stubFetch(box.home, routes), ...extraEnv });
    assert.equal(result.status, 0, result.stderr);
    const entries = fs.readFileSync(path.join(box.dataDir, 'catalog.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { result, entries, meta: JSON.parse(result.stdout), byId: new Map(entries.map((entry) => [entry.id, entry])) };
}

test('a full build indexes installed assets, network sources, and writes meta.json', () => {
    const box = buildSandbox({
        installedSkills: [{ name: 'local-skill', description: 'a local skill', body: 'local vocabulary' }],
        plugins: [{
            dir: 'demo-plugin',
            manifest: JSON.stringify({ name: 'demo-plugin', description: 'demo plugin', license: 'Apache-2.0', interface: { capabilities: ['review'] } }),
            skills: [{ name: 'bundled-skill', description: 'ships with the plugin' }],
        }],
        marketplace: JSON.stringify({ name: 'personal', plugins: [{ name: 'market-plugin', description: 'from the marketplace', category: 'Productivity' }] }),
    });
    const { entries, meta, byId } = build(box);

    assert.deepEqual(meta.errors, []);
    assert.equal(meta.schemaVersion, 3);
    assert.equal(meta.total, entries.length);
    assert.equal(meta.fulltext, true);
    assert.equal(meta.vectors, false);
    assert.deepEqual(meta.counts, {
        skill: entries.filter((entry) => entry.kind === 'skill').length,
        plugin: entries.filter((entry) => entry.kind === 'plugin').length,
        mcp: entries.filter((entry) => entry.kind === 'mcp').length,
    });
    assert.equal(JSON.parse(fs.readFileSync(path.join(box.dataDir, 'meta.json'), 'utf8')).total, meta.total);

    // Installed skill: available without installing anything, body indexed for fulltext search.
    assert.deepEqual(byId.get('skill:local-skill'), {
        id: 'skill:local-skill', kind: 'skill', name: 'local-skill', description: 'a local skill',
        source: 'installed', install: 'Already available in this Codex environment.', fulltext: 'local vocabulary',
        tags: [], platform: 'codex', availability: 'installed', packaging: 'standalone', domain: 'unknown',
        execution: 'prompt', sourceClass: 'unknown', license: 'unknown', maturity: 'unknown',
        surface: ['cli', 'ide', 'desktop'], parentPlugin: null, permissions: ['unknown'],
    });

    // A skill inside a plugin is a plugin-component and remembers its owning plugin.
    assert.equal(byId.get('skill:bundled-skill').packaging, 'plugin-component');
    assert.equal(byId.get('skill:bundled-skill').parentPlugin, 'demo-plugin');
    assert.equal(byId.get('skill:bundled-skill').source, 'installed-plugin');

    // Installed plugin manifest: capabilities become tags, license is carried over.
    assert.equal(byId.get('plugin:demo-plugin').availability, 'installed');
    assert.deepEqual(byId.get('plugin:demo-plugin').tags, ['review']);
    assert.equal(byId.get('plugin:demo-plugin').license, 'Apache-2.0');

    // Marketplace plugin: known to exist, not installed yet.
    assert.equal(byId.get('plugin:market-plugin').source, 'marketplace:personal');
    assert.equal(byId.get('plugin:market-plugin').availability, 'installable');
    assert.deepEqual(byId.get('plugin:market-plugin').tags, ['Productivity']);

    // Official skills are installable; cross-ecosystem and community ones must be adapted first.
    assert.equal(byId.get('skill:pdf').sourceClass, 'official');
    assert.equal(byId.get('skill:pdf').availability, 'installable');
    assert.match(byId.get('skill:pdf').install, /skill-installer with https:\/\/github.com\/openai\/skills\/tree\/main\/pdf$/);
    assert.equal(byId.get('skill:pdf').fulltext, 'pdf body text');
    assert.equal(byId.get('skill:excel').sourceClass, 'community');
    assert.equal(byId.get('skill:excel').availability, 'copy-and-adapt');
    assert.equal(byId.get('skill:volt-skill').sourceClass, 'community');
    assert.equal(byId.get('skill:volt-skill').description, 'a community skill');
    assert.deepEqual(byId.get('skill:security/audit').tags, ['security', 'sast']);

    // MCP entries stay provenance-unknown and never interpolate the registry name into a command.
    const mcp = byId.get('mcp:io.example/db');
    assert.equal(mcp.install, 'codex mcp add <name> --url https://mcp.example.com/db');
    assert.equal(mcp.sourceClass, 'unknown');
    assert.equal(mcp.execution, 'external-service');
});

test('a bare Codex home still produces a catalog from the network sources alone', () => {
    const { entries, meta } = build(sandbox('build-index-bare'));
    assert.deepEqual(meta.errors, []);
    assert.deepEqual(entries.map((entry) => entry.id).sort(), ['mcp:io.example/db', 'skill:excel', 'skill:pdf', 'skill:security/audit', 'skill:volt-skill']);
});

test('dedup keeps the highest-priority entry for a kind+name collision', () => {
    const box = buildSandbox({ installedSkills: [{ name: 'pdf', description: 'my own pdf skill' }] });
    const { entries, byId } = build(box);
    assert.equal(entries.filter((entry) => entry.id === 'skill:pdf').length, 1);
    assert.equal(byId.get('skill:pdf').source, 'installed');
    assert.equal(byId.get('skill:pdf').description, 'my own pdf skill');
});

test('the MCP registry is paginated and the newest record for a name wins', () => {
    const routes = defaultRoutes([
        {
            match: 'cursor=page-2',
            json: { servers: [{ server: { name: 'io.example/db', description: 'newer record', packages: [{ identifier: 'db-mcp' }] } }] },
        },
        {
            match: REGISTRY,
            json: {
                servers: [
                    { server: { name: 'io.example/db', description: 'older record', remotes: [{ url: 'https://old.example.com' }] } },
                    { server: { name: 'io.example/retired', description: 'retired' }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deleted' } } },
                    { server: { name: 'io.example/active', description: 'kept' }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } } },
                    { server: { description: 'nameless servers are skipped' } },
                ],
                metadata: { nextCursor: 'page-2' },
            },
        },
    ]);
    const { entries, byId } = build(sandbox('build-index-registry'), routes);

    assert.equal(byId.get('mcp:io.example/db').description, 'newer record');
    assert.equal(byId.get('mcp:io.example/db').install, 'codex mcp add <name> -- npx -y db-mcp');
    assert.equal(byId.has('mcp:io.example/retired'), false);
    assert.equal(byId.get('mcp:io.example/active').install, 'Review the server in the MCP Registry before configuring it in Codex.');
    assert.deepEqual(entries.filter((entry) => entry.kind === 'mcp').map((entry) => entry.name).sort(), ['io.example/active', 'io.example/db']);
});

test('external values that could reach a shell command are rejected, not sanitized', () => {
    const routes = defaultRoutes([
        { match: VOLTAGENT, text: '- **[evil](https://example.com/x; rm -rf /)** - shell metacharacters\n- **[ok](https://example.com/ok)** - fine\n' },
        { match: TEMPLATES, json: { skills: [{ path: '../../etc/passwd', description: 'traversal' }, { path: 'ok/path', description: 'fine' }] } },
        { match: REGISTRY, json: { servers: [{ server: { name: 'io.example/evil', description: 'evil', remotes: [{ url: 'https://x.example/$(whoami)' }], packages: [{ identifier: 'safe-pkg' }] } }] } },
    ]);
    const { meta, byId } = build(sandbox('build-index-unsafe'), routes);

    assert.equal(byId.has('skill:evil'), false);
    assert.equal(byId.has('skill:../../etc/passwd'), false);
    assert.equal(byId.get('skill:ok').install, 'Review https://example.com/ok and adapt the skill for Codex before installation.');
    assert.ok(byId.has('skill:ok/path'));
    // An unsafe remote URL falls through to the package identifier instead of being emitted.
    assert.equal(byId.get('mcp:io.example/evil').install, 'codex mcp add <name> -- npx -y safe-pkg');

    assert.ok(meta.errors.some((error) => error.startsWith('VoltAgent/awesome-agent-skills: skipped unsafe value')));
    assert.ok(meta.errors.some((error) => error.startsWith('aitmpl.com: skipped unsafe path')));
    assert.ok(meta.errors.some((error) => error.startsWith('mcp-registry: skipped unsafe value')));
});

test('a failing source is recorded in meta.errors and the rest of the build continues', () => {
    const routes = defaultRoutes([
        { match: TEMPLATES, status: 503 },
        { match: `${RAW}/main/pdf/SKILL.md`, status: 404 },
    ]);
    const { meta, byId } = build(sandbox('build-index-errors'), routes);
    assert.ok(meta.errors.some((error) => /^templates: .*components\.json: HTTP 503$/.test(error)));
    assert.ok(meta.errors.some((error) => /^openai\/skills:pdf\/SKILL\.md: .*HTTP 404$/.test(error)));
    assert.equal(byId.has('skill:pdf'), false);
    assert.ok(byId.has('skill:excel'));
    assert.ok(byId.has('mcp:io.example/db'));
});

test('unreadable installed manifests and marketplaces are reported per file', () => {
    const box = buildSandbox({
        plugins: [{ dir: 'broken-plugin', manifest: '{ not json' }],
        marketplace: '{ also not json',
    });
    const { meta, entries } = build(box);
    assert.ok(meta.errors.some((error) => /^plugin:.*broken-plugin.*plugin\.json: /.test(error)));
    assert.ok(meta.errors.some((error) => error.startsWith('marketplace: ')));
    assert.equal(entries.some((entry) => entry.name === 'broken-plugin'), false);
});

test('a plugin manifest without a name falls back to its directory name and shortDescription', () => {
    const box = buildSandbox({
        plugins: [{ dir: 'unnamed-plugin', manifest: JSON.stringify({ interface: { shortDescription: 'no name field' } }) }],
    });
    const { byId } = build(box);
    assert.equal(byId.get('plugin:unnamed-plugin').description, 'no name field');
    assert.equal(byId.get('plugin:unnamed-plugin').packaging, 'plugin');
});

test('a SKILL.md without frontmatter is named after its directory', () => {
    const box = buildSandbox();
    writeFile(path.join(box.codexHome, 'skills', 'nameless', 'SKILL.md'), 'no frontmatter here\n');
    const { byId } = build(box);
    assert.equal(byId.get('skill:nameless').description, '');
    assert.equal(byId.get('skill:nameless').fulltext, 'no frontmatter here');
});

test('lite mode drops indexed body text', () => {
    const box = buildSandbox({
        installedSkills: [{ name: 'local-skill', description: 'a local skill', body: 'local vocabulary' }],
        config: { fulltext: false },
    });
    const { entries, meta } = build(box);
    assert.equal(meta.fulltext, false);
    assert.equal(entries.every((entry) => !('fulltext' in entry)), true);
});

test('a configured vector provider without its key downgrades to lexical search', () => {
    const box = buildSandbox({ config: { vectors: { provider: 'openai' } } });
    const { meta } = build(box, defaultRoutes(), { OPENAI_API_KEY: '' });
    assert.equal(meta.vectors, false);
    assert.ok(meta.errors.includes('vectors: OPENAI_API_KEY is not set; using lexical search.'));
    assert.equal(fs.existsSync(path.join(box.dataDir, 'vectors.bin')), false);
});

test('vectors are embedded and stored alongside the catalog when a provider is configured', () => {
    const box = buildSandbox({ config: { vectors: { provider: 'openai' } } });
    const { meta } = build(box, defaultRoutes([{ match: '/embeddings', embed: 4 }]), { OPENAI_API_KEY: 'k' });
    assert.equal(meta.vectors, true);
    assert.deepEqual(meta.errors, []);
    const vectorMeta = JSON.parse(fs.readFileSync(path.join(box.dataDir, 'vectors.json'), 'utf8'));
    assert.equal(vectorMeta.provider, 'openai');
    assert.equal(vectorMeta.dims, 4);
    assert.equal(vectorMeta.count, meta.total);
    assert.equal(fs.statSync(path.join(box.dataDir, 'vectors.bin')).size, 4 * meta.total * 4);
});

test('a failing embedding request keeps the catalog and records the failure', () => {
    const box = buildSandbox({ config: { vectors: { provider: 'openai' } } });
    const { meta } = build(box, defaultRoutes([{ match: '/embeddings', status: 500 }]), { OPENAI_API_KEY: 'k' });
    assert.equal(meta.vectors, false);
    assert.ok(meta.errors.some((error) => error.startsWith('vectors: Embedding API HTTP 500')));
    assert.ok(meta.total > 0);
});

test('an unknown vector provider fails the build loudly', () => {
    const box = buildSandbox({ config: { vectors: { provider: 'nope' } } });
    const result = runScript('build-index.mjs', [], box, stubFetch(box.home, defaultRoutes()));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown vector provider: nope/);
});
