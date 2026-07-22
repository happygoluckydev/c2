#!/usr/bin/env node
// Audit user-installed Codex skills. --apply moves unused skills to an archive; it never deletes them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODEX_HOME, parseFrontmatter, walk } from './catalog.mjs';

const skillsDir = path.join(CODEX_HOME, 'skills'); const archiveDir = path.join(CODEX_HOME, 'skills-archive'); const sessionsDir = path.join(CODEX_HOME, 'sessions'); const apply = process.argv.includes('--apply');
const installed = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md'))).map((entry) => { const fm = parseFrontmatter(fs.readFileSync(path.join(skillsDir, entry.name, 'SKILL.md'), 'utf8')); return { dir: entry.name, name: fm.name || entry.name, tokens: Math.round(fm.fmLen / 4) }; }) : [];
const sessionFiles = walk(sessionsDir, (candidate) => candidate.endsWith('.jsonl'));
const used = new Set(); for (const file of sessionFiles) { try { const text = fs.readFileSync(file, 'utf8'); for (const skill of installed) if (new RegExp(`\\b${skill.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) used.add(skill.name); } catch { /* ignore unreadable transcript */ } }
const unused = installed.filter((skill) => !used.has(skill.name)); const canArchive = sessionFiles.length > 0;
console.log(JSON.stringify({ installed: installed.length, sessionFilesScanned: sessionFiles.length, used: [...used], unused: unused.map((skill) => skill.name), estimatedTaxTokensPerSession: unused.reduce((sum, skill) => sum + skill.tokens, 0), mode: apply ? 'apply' : 'dry-run', archiveAllowed: canArchive }, null, 2));
if (apply && !canArchive) { console.error('No Codex session transcripts were found; refusing to archive skills because usage cannot be determined.'); process.exitCode = 2; }
else if (apply && unused.length) {
  fs.mkdirSync(archiveDir, { recursive: true });
  let archived = 0;
  for (const skill of unused) {
    const dest = path.join(archiveDir, skill.dir);
    try { fs.renameSync(path.join(skillsDir, skill.dir), fs.existsSync(dest) ? `${dest}-${Date.now()}` : dest); archived += 1; }
    catch (error) { console.error(`Failed to archive ${skill.dir}: ${error.message}`); }
  }
  console.log(`Archived ${archived} skills in ${archiveDir}.`);
}
