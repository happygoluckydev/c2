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
import { CODEX_HOME, parseFrontmatter, walk } from './catalog.mjs';

const skillsDir = path.join(CODEX_HOME, 'skills');
const archiveDir = path.join(CODEX_HOME, 'skills-archive');
const sessionsDir = path.join(CODEX_HOME, 'sessions');
const apply = process.argv.includes('--apply');

// --- Installed skills, with an estimated per-session token cost from their frontmatter length ---
// An unreadable SKILL.md is reported and excluded from the audit rather than aborting it or being
// counted as unused: its name is unknown, so it could never match a transcript and would be
// archived on a false negative.
const unreadableSkills = [];
const installed = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md')))
        .flatMap((entry) => {
            try {
                const fm = parseFrontmatter(fs.readFileSync(path.join(skillsDir, entry.name, 'SKILL.md'), 'utf8'));
                return [{ dir: entry.name, name: fm.name || entry.name, tokens: Math.round(fm.fmLen / 4) }];
            } catch (error) {
                console.error(`Cannot read ${path.join(skillsDir, entry.name, 'SKILL.md')}: ${error.message}; excluding it from the audit.`);
                unreadableSkills.push(entry.name);
                return [];
            }
        })
    : [];

// --- Scan every session transcript for a mention of each installed skill's name ---
// Codex transcripts don't carry a structured "which skill ran" field the way Claude Code session
// logs carry `subagent_type`, so usage is inferred from a whole-transcript name match instead.
// An unreadable transcript (or transcript directory) is not a neutral skip: the usage evidence it
// holds is exactly what keeps a skill out of the unused list, so skipping it silently biases the
// audit toward archiving. Every failure is reported and counted, and any failure blocks --apply.
const unreadableSessionFiles = [];
const sessionFiles = walk(sessionsDir, (candidate) => candidate.endsWith('.jsonl'), (dir, error) => {
    console.error(`Cannot list session directory ${dir}: ${error.message}; transcripts under it were not scanned.`);
    unreadableSessionFiles.push(dir);
});
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
    } catch (error) {
        console.error(`Cannot read session transcript ${file}: ${error.message}; usage evidence from it is missing.`);
        unreadableSessionFiles.push(file);
    }
}

const unused = installed.filter((skill) => !used.has(skill.name));
// Refuse to archive on a false "unused" read: either from having no transcripts to check at all,
// or from transcripts that could not be read (their evidence is unaccounted for).
const canArchive = sessionFiles.length > 0 && unreadableSessionFiles.length === 0;

// Resident-tax estimate: the skill list shown to the model is roughly frontmatter length / 4
// tokens per skill, repeated on every API call in every session that skill sits installed but idle.
console.log(JSON.stringify({
    installed: installed.length,
    unreadableSkills,
    sessionFilesScanned: sessionFiles.length,
    unreadableSessionFiles: unreadableSessionFiles.length,
    used: [...used],
    unused: unused.map((skill) => skill.name),
    estimatedTaxTokensPerSession: unused.reduce((sum, skill) => sum + skill.tokens, 0),
    mode: apply ? 'apply' : 'dry-run',
    archiveAllowed: canArchive,
}, null, 2));

if (apply && !canArchive) {
    console.error(sessionFiles.length === 0
        ? 'No Codex session transcripts were found; refusing to archive skills because usage cannot be determined.'
        : `${unreadableSessionFiles.length} session path(s) could not be read; refusing to archive skills because usage cannot be determined.`);
    process.exitCode = 2;
} else if (apply && unused.length) {
    fs.mkdirSync(archiveDir, { recursive: true });
    let archived = 0;
    let failed = 0;
    for (const skill of unused) {
        const dest = path.join(archiveDir, skill.dir);
        try {
            // Archiving never deletes; a name collision in the archive gets a timestamp suffix
            // instead of silently overwriting a previously archived skill of the same name.
            fs.renameSync(path.join(skillsDir, skill.dir), fs.existsSync(dest) ? `${dest}-${Date.now()}` : dest);
            archived += 1;
        } catch (error) {
            console.error(`Failed to archive ${skill.dir}: ${error.message}`);
            failed += 1;
        }
    }
    console.log(`Archived ${archived} of ${unused.length} skills in ${archiveDir}.`);
    // Per-skill archive failures were previously only printed, so the command still exited 0 and a
    // caller (or a script wrapping it) could not tell a full archive from a completely failed one.
    if (failed) process.exitCode = 1;
}
