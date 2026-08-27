// SPDX-License-Identifier: MIT
// Shared helpers for the c2 script tests: temporary CODEX_HOME sandboxes and script invocation.
// The CLI scripts (build-index/search/prune) are entry points without exports, so they are
// exercised as child processes with CODEX_HOME/HOME pointed at a throwaway directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

export function sandbox(prefix) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `c2-${prefix}-`));
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(path.join(codexHome, 'c2'), { recursive: true });
    return { home, codexHome, dataDir: path.join(codexHome, 'c2') };
}

export function writeFile(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

export function writeSkill(dir, { name, description = '', body = '' }) {
    return writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

// Returns the env additions that make a script under test resolve every fetch through
// test-fixtures/route-fetch.mjs. An empty route list makes the whole network unreachable.
export function stubFetch(home, routes = []) {
    const file = writeFile(path.join(home, 'routes.json'), JSON.stringify(routes));
    return {
        C2_TEST_ROUTES: file,
        NODE_OPTIONS: `--import ${path.join(SCRIPTS_DIR, 'test-fixtures', 'route-fetch.mjs')}`,
    };
}

export function runScript(script, args = [], { home, codexHome }, extraEnv = {}) {
    const result = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, script), ...args], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, ...extraEnv },
    });
    return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}
