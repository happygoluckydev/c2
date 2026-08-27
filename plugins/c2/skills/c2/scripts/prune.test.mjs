// SPDX-License-Identifier: MIT
// Tests for prune.mjs, the installed-skill audit CLI. Each case builds a throwaway CODEX_HOME with
// installed skills and session transcripts, then runs the script as a child process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runScript, sandbox, writeFile, writeSkill } from './test-helpers.mjs';

function pruneSandbox({ skills = [], sessions = [] } = {}) {
    const box = sandbox('prune');
    for (const skill of skills) {
        if (skill.noSkillFile) fs.mkdirSync(path.join(box.codexHome, 'skills', skill.dir), { recursive: true });
        else writeSkill(path.join(box.codexHome, 'skills', skill.dir), skill);
    }
    sessions.forEach((content, index) => {
        writeFile(path.join(box.codexHome, 'sessions', '2026', `session-${index}.jsonl`), content);
    });
    return box;
}

const report = (stdout) => JSON.parse(stdout.slice(0, stdout.indexOf('\n}') + 2));

test('a skill mentioned in a transcript counts as used', () => {
    const box = pruneSandbox({
        skills: [{ dir: 'used-skill', name: 'used-skill', description: 'x' }, { dir: 'idle-skill', name: 'idle-skill', description: 'y' }],
        sessions: ['{"text":"ran Used-Skill for the user"}\n'],
    });
    const result = runScript('prune.mjs', [], box);
    assert.equal(result.status, 0);
    const parsed = report(result.stdout);
    assert.equal(parsed.installed, 2);
    assert.equal(parsed.sessionFilesScanned, 1);
    assert.deepEqual(parsed.used, ['used-skill']);
    assert.deepEqual(parsed.unused, ['idle-skill']);
    assert.equal(parsed.mode, 'dry-run');
    assert.equal(parsed.archiveAllowed, true);
    assert.ok(parsed.estimatedTaxTokensPerSession > 0);
    // A dry run never touches the skills directory.
    assert.deepEqual(fs.readdirSync(path.join(box.codexHome, 'skills')).sort(), ['idle-skill', 'used-skill']);
});

test('a skill name only appearing as a substring is still unused', () => {
    const box = pruneSandbox({
        skills: [{ dir: 'pdf', name: 'pdf', description: 'x' }],
        sessions: ['{"text":"used the pdfexport helper"}\n'],
    });
    assert.deepEqual(report(runScript('prune.mjs', [], box).stdout).unused, ['pdf']);
});

test('regex metacharacters in a skill name are matched literally', () => {
    const box = pruneSandbox({
        skills: [{ dir: 'plus', name: 'c++ helper', description: 'x' }],
        sessions: ['{"text":"invoked c++ helper once"}\n'],
    });
    assert.deepEqual(report(runScript('prune.mjs', [], box).stdout).used, ['c++ helper']);
});

test('the frontmatter name wins over the directory name, and directories without SKILL.md are ignored', () => {
    const box = pruneSandbox({
        skills: [{ dir: 'dir-name', name: 'frontmatter-name', description: 'x' }, { dir: 'not-a-skill', noSkillFile: true }],
        sessions: ['{}\n'],
    });
    const parsed = report(runScript('prune.mjs', [], box).stdout);
    assert.equal(parsed.installed, 1);
    assert.deepEqual(parsed.unused, ['frontmatter-name']);
});

test('an empty Codex home reports nothing installed', () => {
    const parsed = report(runScript('prune.mjs', [], sandbox('prune-empty')).stdout);
    assert.deepEqual(parsed, {
        installed: 0, sessionFilesScanned: 0, used: [], unused: [],
        estimatedTaxTokensPerSession: 0, mode: 'dry-run', archiveAllowed: false,
    });
});

test('--apply refuses to archive when there are no transcripts to judge usage from', () => {
    const box = pruneSandbox({ skills: [{ dir: 'idle-skill', name: 'idle-skill', description: 'x' }] });
    const result = runScript('prune.mjs', ['--apply'], box);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /refusing to archive skills because usage cannot be determined/);
    assert.equal(report(result.stdout).mode, 'apply');
    assert.deepEqual(fs.readdirSync(path.join(box.codexHome, 'skills')), ['idle-skill']);
});

test('--apply moves unused skills into the archive and keeps used ones installed', () => {
    const box = pruneSandbox({
        skills: [{ dir: 'used-skill', name: 'used-skill', description: 'x' }, { dir: 'idle-skill', name: 'idle-skill', description: 'y' }],
        sessions: ['{"text":"used-skill"}\n'],
    });
    const result = runScript('prune.mjs', ['--apply'], box);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Archived 1 skills in/);
    assert.deepEqual(fs.readdirSync(path.join(box.codexHome, 'skills')), ['used-skill']);
    assert.deepEqual(fs.readdirSync(path.join(box.codexHome, 'skills-archive')), ['idle-skill']);
});

test('--apply never overwrites a previously archived skill of the same name', () => {
    const box = pruneSandbox({
        skills: [{ dir: 'idle-skill', name: 'idle-skill', description: 'x' }],
        sessions: ['{"text":"something else"}\n'],
    });
    writeFile(path.join(box.codexHome, 'skills-archive', 'idle-skill', 'SKILL.md'), 'older archive');
    const result = runScript('prune.mjs', ['--apply'], box);
    assert.equal(result.status, 0);
    const archived = fs.readdirSync(path.join(box.codexHome, 'skills-archive')).sort();
    assert.equal(archived.length, 2);
    assert.equal(fs.readFileSync(path.join(box.codexHome, 'skills-archive', 'idle-skill', 'SKILL.md'), 'utf8'), 'older archive');
    assert.match(archived[1], /^idle-skill-\d+$/);
});

test('--apply with nothing unused leaves the archive directory untouched', () => {
    const box = pruneSandbox({
        skills: [{ dir: 'used-skill', name: 'used-skill', description: 'x' }],
        sessions: ['{"text":"used-skill"}\n'],
    });
    const result = runScript('prune.mjs', ['--apply'], box);
    assert.equal(result.status, 0);
    assert.equal(fs.existsSync(path.join(box.codexHome, 'skills-archive')), false);
});

test('scanning stops once every installed skill has been seen', () => {
    const box = pruneSandbox({
        skills: [{ dir: 'used-skill', name: 'used-skill', description: 'x' }],
        sessions: ['{"text":"used-skill"}\n', '{"text":"second transcript"}\n', '{"text":"third transcript"}\n'],
    });
    const parsed = report(runScript('prune.mjs', [], box).stdout);
    assert.equal(parsed.sessionFilesScanned, 3);
    assert.deepEqual(parsed.used, ['used-skill']);
});
