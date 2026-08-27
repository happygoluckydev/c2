#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// c2: installed-asset audit (session-level credit efficiency)
//
// Background: an installed skill's name+description is available to the model in every session,
// so an unused skill keeps costing resident context indefinitely ("resident tax") even though it
// is never invoked. Trimming that recurring tax matters more, per session, than shaving a single
// prompt.
//
// Behavior: scan Codex session transcripts (~/.codex/sessions/**/*.jsonl) for mentions of each
// installed skill's name, then report which skills never showed up.
//   node prune.mjs           # dry run (report only)
//   node prune.mjs --apply   # archive unused skills to ~/.codex/skills-archive/ (never deletes)
import fs from 'node:fs';
import path from 'node:path';
import { CODEX_HOME, readFrontmatterFile, walk } from './catalog.mjs';

const skillsDir = path.join(CODEX_HOME, 'skills');
const archiveDir = path.join(CODEX_HOME, 'skills-archive');
const sessionsDir = path.join(CODEX_HOME, 'sessions');
const apply = process.argv.includes('--apply');

// --- Installed skills, with an estimated per-session token cost from their frontmatter length ---
const installed = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md')))
        .map((entry) => {
            const fm = readFrontmatterFile(path.join(skillsDir, entry.name, 'SKILL.md'));
            return { dir: entry.name, name: fm.name || entry.name, tokens: Math.round(fm.fmLen / 4) };
        })
    : [];

// --- Scan every session transcript for a mention of each installed skill's name ---
// Codex transcripts don't carry a structured "which skill ran" field the way Claude Code session
// logs carry `subagent_type`, so usage is inferred from a whole-transcript name match instead.
const sessionFiles = walk(sessionsDir, (candidate) => candidate.endsWith('.jsonl'));
const used = new Set();
// Once every installed skill has a confirmed hit, further scanning can't change the result — stop
// early so a very large session history doesn't get scanned in full for no benefit.
const allDetermined = () => installed.every((skill) => used.has(skill.name));
for (const file of sessionFiles) {
    if (allDetermined()) break;
    try {
        const text = fs.readFileSync(file, 'utf8');
        for (const skill of installed) {
            if (used.has(skill.name)) continue;
            const pattern = new RegExp(`\\b${skill.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (pattern.test(text)) used.add(skill.name);
        }
    } catch { /* unreadable transcript — skip it, it just can't confirm usage */ }
}

const unused = installed.filter((skill) => !used.has(skill.name));
// Refuse to archive on a false "unused" read caused by having no transcripts to check at all.
const canArchive = sessionFiles.length > 0;

// Resident-tax estimate: the skill list shown to the model is roughly frontmatter length / 4
// tokens per skill, repeated on every API call in every session that skill sits installed but idle.
console.log(JSON.stringify({
    installed: installed.length,
    sessionFilesScanned: sessionFiles.length,
    used: [...used],
    unused: unused.map((skill) => skill.name),
    estimatedTaxTokensPerSession: unused.reduce((sum, skill) => sum + skill.tokens, 0),
    mode: apply ? 'apply' : 'dry-run',
    archiveAllowed: canArchive,
}, null, 2));

if (apply && !canArchive) {
    console.error('No Codex session transcripts were found; refusing to archive skills because usage cannot be determined.');
    process.exitCode = 2;
} else if (apply && unused.length) {
    fs.mkdirSync(archiveDir, { recursive: true });
    let archived = 0;
    for (const skill of unused) {
        const dest = path.join(archiveDir, skill.dir);
        try {
            // Archiving never deletes; a name collision in the archive gets a timestamp suffix
            // instead of silently overwriting a previously archived skill of the same name.
            fs.renameSync(path.join(skillsDir, skill.dir), fs.existsSync(dest) ? `${dest}-${Date.now()}` : dest);
            archived += 1;
        } catch (error) { console.error(`Failed to archive ${skill.dir}: ${error.message}`); }
    }
    console.log(`Archived ${archived} skills in ${archiveDir}.`);
}
