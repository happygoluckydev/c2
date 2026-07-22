#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CATALOG, CODEX_HOME, DATA_DIR, META, clipped, embedTexts, loadConfig, parseFrontmatter, resolveProvider, walk, writeAtomic, writeVectors } from './catalog.mjs';

const config = loadConfig(); const errors = []; const entries = []; const home = os.homedir();
const add = (entry) => entries.push({ tags: [], ...entry });
const fetchOk = async (url) => { const response = await fetch(url, { headers: { 'User-Agent': 'c2-codex-concierge' } }); if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`); return response; };
const fetchJson = (url) => fetchOk(url).then((response) => response.json());
const fetchText = (url) => fetchOk(url).then((response) => response.text());

function indexSkills(root, source) { for (const file of walk(root, (candidate) => path.basename(candidate) === 'SKILL.md')) try {
  const fm = parseFrontmatter(fs.readFileSync(file, 'utf8')); add({ kind: 'skill', name: fm.name || path.basename(path.dirname(file)), description: fm.description || '', source, install: 'Already available in this Codex environment.', fulltext: clipped(fm.body) });
} catch (error) { errors.push(`skill:${file}: ${error.message}`); } }
function indexPlugins(root, source) { for (const file of walk(root, (candidate) => path.basename(candidate) === 'plugin.json' && path.basename(path.dirname(candidate)) === '.codex-plugin')) try {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')); add({ kind: 'plugin', name: manifest.name || path.basename(path.dirname(path.dirname(file))), description: manifest.description || manifest.interface?.shortDescription || '', source, tags: manifest.interface?.capabilities || [], install: 'Already available in this Codex environment.' });
} catch (error) { errors.push(`plugin:${file}: ${error.message}`); } }
function indexMarketplace() { const file = path.join(home, '.agents', 'plugins', 'marketplace.json'); if (!fs.existsSync(file)) return; try {
  const marketplace = JSON.parse(fs.readFileSync(file, 'utf8')); for (const plugin of marketplace.plugins || []) { if (!plugin.name) continue; add({ kind: 'plugin', name: plugin.name, description: plugin.description || '', source: `marketplace:${marketplace.name || 'personal'}`, tags: [plugin.category].filter(Boolean), install: 'Install or enable it from the Codex Plugins view.' }); }
} catch (error) { errors.push(`marketplace: ${error.message}`); } }
async function indexRepoSkills(repo, ref, source, install) {
  const tree = await fetchJson(`https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`);
  const paths = (tree.tree || []).map((entry) => entry.path).filter((file) => /(^|\/)SKILL\.md$/.test(file));
  const records = await Promise.allSettled(paths.map(async (file) => { const fm = parseFrontmatter(await fetchText(`https://raw.githubusercontent.com/${repo}/${ref}/${file}`)); return { kind: 'skill', name: fm.name || path.basename(path.dirname(file)), description: fm.description || '', source, tags: source === 'openai/skills' ? ['official'] : ['community'], install: install(file), fulltext: clipped(fm.body) }; }));
  records.forEach((record, index) => { if (record.status === 'fulfilled') add(record.value); else errors.push(`${source}:${paths[index]}: ${record.reason?.message || record.reason}`); });
}
async function indexOpenAISkills() { return indexRepoSkills('openai/skills', 'main', 'openai/skills', (file) => `Use skill-installer with https://github.com/openai/skills/tree/main/${path.dirname(file)}`); }
async function indexAnthropicSkills() { return indexRepoSkills('anthropics/skills', 'main', 'anthropics/skills', (file) => `Review and copy the compatible skill directory from https://github.com/anthropics/skills/tree/main/${path.dirname(file)} into a Codex skills location.`); }
async function indexVoltAgentSkills() { const text = await fetchText('https://raw.githubusercontent.com/VoltAgent/awesome-agent-skills/main/README.md'); const pattern = /^\s*-\s*\*\*\[([^\]]+)\]\(([^)]+)\)\*\*\s*[-–—]\s*(.+)$/gm; let match; while ((match = pattern.exec(text))) add({ kind: 'skill', name: match[1].trim(), description: match[3].trim(), source: 'VoltAgent/awesome-agent-skills', tags: ['community'], install: `Review ${match[2]} and adapt the skill for Codex before installation.` }); }
async function indexTemplates() { const catalog = await fetchJson('https://raw.githubusercontent.com/davila7/claude-code-templates/main/docs/components.json'); for (const skill of catalog.skills || []) if (skill.path) add({ kind: 'skill', name: skill.path, description: (skill.description || '').slice(0, 300), source: 'aitmpl.com', tags: [skill.category, ...(skill.keywords || [])].filter(Boolean).slice(0, 12), install: 'Community template: review and adapt it for Codex before installation.' }); }
async function indexMcpRegistry() { let cursor; for (let page = 0; page < 60; page += 1) {
  const url = new URL('https://registry.modelcontextprotocol.io/v0/servers'); url.searchParams.set('limit', '100'); if (cursor) url.searchParams.set('cursor', cursor); const result = await fetchJson(url);
  for (const row of result.servers || []) { const server = row.server || row; if (!server.name) continue; const status = row._meta?.['io.modelcontextprotocol.registry/official']?.status; if (status && status !== 'active') continue; const remote = server.remotes?.[0]; const packageInfo = server.packages?.[0]; let install = 'Review the server in the MCP Registry before configuring it in Codex.'; if (remote?.url) install = `codex mcp add ${server.name} --url ${remote.url}`; else if (packageInfo?.identifier) install = `codex mcp add ${server.name} -- npx -y ${packageInfo.identifier}`; add({ kind: 'mcp', name: server.name, description: server.description || '', source: 'MCP Registry', install }); }
  cursor = result.metadata?.nextCursor; if (!cursor) break;
} }

indexSkills(path.join(CODEX_HOME, 'skills'), 'installed'); indexSkills(path.join(CODEX_HOME, 'plugins'), 'installed-plugin'); indexPlugins(path.join(CODEX_HOME, 'plugins'), 'installed'); indexPlugins(path.join(home, '.agents', 'plugins'), 'installed'); indexMarketplace();
const jobs = [['openai/skills', indexOpenAISkills], ['anthropics/skills', indexAnthropicSkills], ['VoltAgent skills', indexVoltAgentSkills], ['templates', indexTemplates], ['MCP Registry', indexMcpRegistry]];
const results = await Promise.allSettled(jobs.map(([, job]) => job())); results.forEach((result, index) => { if (result.status === 'rejected') errors.push(`${jobs[index][0]}: ${result.reason?.message || result.reason}`); });
const seen = new Set(); const unique = entries.filter((entry) => { const key = `${entry.kind}:${entry.name}`.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
if (config.fulltext === false) for (const entry of unique) delete entry.fulltext;
fs.mkdirSync(DATA_DIR, { recursive: true }); writeAtomic(CATALOG, `${unique.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
let vectors = false; const provider = resolveProvider(config); if (provider?.missingKey) errors.push(`vectors: ${provider.missingKey} is not set; using lexical search.`); else if (provider) try { const vectorsData = await embedTexts(unique.map((entry) => `${entry.name}. ${(entry.tags || []).join(' ')}. ${entry.description}`.slice(0, 1500)), provider); writeVectors(vectorsData, { provider: provider.name, model: provider.model, builtAt: new Date().toISOString() }); vectors = true; } catch (error) { errors.push(`vectors: ${error.message}`); }
const counts = Object.fromEntries(['skill', 'plugin', 'mcp'].map((kind) => [kind, unique.filter((entry) => entry.kind === kind).length])); const meta = { builtAt: new Date().toISOString(), total: unique.length, counts, fulltext: config.fulltext !== false, vectors, errors }; fs.writeFileSync(META, JSON.stringify(meta, null, 2)); console.log(JSON.stringify(meta, null, 2));
