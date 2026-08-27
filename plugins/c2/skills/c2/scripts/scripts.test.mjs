// SPDX-License-Identifier: MIT
// End-to-end checks for the failure paths of the two entry-point scripts: they only matter as
// process behavior (exit code + stderr), so each case runs the real script against a throwaway
// CODEX_HOME instead of importing it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CATALOG_SCHEMA_VERSION, withCatalogMetadata } from './catalog.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRUNE = path.join(HERE, 'prune.mjs');
const SEARCH = path.join(HERE, 'search.mjs');

// A fresh, schema-current meta.json keeps search.mjs from deciding the catalog is stale and
// spawning a background crawl (no test should touch the network).
function codexHome(t) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-home-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.mkdirSync(path.join(home, 'c2'), { recursive: true });
    return home;
}

function writeCatalog(home, lines, meta = {}) {
    fs.writeFileSync(path.join(home, 'c2', 'catalog.jsonl'), `${lines.join('\n')}\n`);
    fs.writeFileSync(path.join(home, 'c2', 'meta.json'), JSON.stringify({
        schemaVersion: CATALOG_SCHEMA_VERSION, builtAt: new Date().toISOString(), total: lines.length, ...meta,
    }));
}

const entryLine = (name) => JSON.stringify(withCatalogMetadata({
    kind: 'skill', name, description: 'handles stripe refunds', source: 'installed', availability: 'installed',
}));

const run = (script, args, home) => spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8',
});

// prune.mjs prints its JSON report first and may append plain-text lines after it.
const report = (stdout) => JSON.parse(stdout.slice(0, stdout.indexOf('\n}') + 2));

test('search reports unparseable catalog lines instead of dropping them silently', (t) => {
    const home = codexHome(t);
    writeCatalog(home, [entryLine('stripe-refunds'), '{ truncated']);

    const result = run(SEARCH, ['--all', 'stripe refunds'], home);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /Skipped 1 unparseable catalog line/);
    assert.match(result.stdout, /stripe-refunds/);
});

test('search fails loudly when no catalog line is usable', (t) => {
    const home = codexHome(t);
    writeCatalog(home, ['{ truncated', 'also not json']);

    const result = run(SEARCH, ['--all', 'stripe refunds'], home);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No usable entries in .*catalog\.jsonl/);
});

test('search treats a meta.json with an unreadable build timestamp as stale', (t) => {
    const home = codexHome(t);
    writeCatalog(home, [entryLine('stripe-refunds')], { builtAt: 'not-a-date' });

    // C2_FETCH_TIMEOUT_MS keeps the refresh this triggers from doing real network work for long;
    // the assertion is only that staleness was detected rather than swallowed as "fresh forever".
    const result = spawnSync(process.execPath, [SEARCH, '--all', 'stripe refunds'], {
        env: { ...process.env, CODEX_HOME: home, C2_FETCH_TIMEOUT_MS: '1' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /Catalog is stale/);
});

test('prune refuses to archive when a session transcript cannot be read', (t) => {
    const home = codexHome(t);
    const skill = path.join(home, 'skills', 'unused-skill');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: unused-skill\ndescription: demo\n---\nbody');
    const transcript = path.join(home, 'sessions', 'session.jsonl');
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '{"role":"user"}\n');
    fs.chmodSync(transcript, 0o000);

    const result = run(PRUNE, ['--apply'], home);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /refusing to archive/);
    assert.equal(report(result.stdout).archiveAllowed, false);
    assert.ok(fs.existsSync(path.join(skill, 'SKILL.md')), 'the skill must not be archived');
});

test('prune archives only when usage evidence is complete', (t) => {
    const home = codexHome(t);
    for (const name of ['used-skill', 'unused-skill']) {
        fs.mkdirSync(path.join(home, 'skills', name), { recursive: true });
        fs.writeFileSync(path.join(home, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: demo\n---\nbody`);
    }
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, 'sessions', 'session.jsonl'), '{"text":"ran used-skill here"}\n');

    const result = run(PRUNE, ['--apply'], home);
    assert.equal(result.status, 0);
    const audit = report(result.stdout);
    assert.deepEqual(audit.unused, ['unused-skill']);
    assert.equal(audit.unreadableSessionFiles, 0);
    assert.ok(fs.existsSync(path.join(home, 'skills-archive', 'unused-skill')));
    assert.ok(fs.existsSync(path.join(home, 'skills', 'used-skill')));
});
