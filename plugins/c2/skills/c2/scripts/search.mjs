#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CATALOG, META, embedTexts, loadConfig, readVectors, resolveProvider } from './catalog.mjs';

const args = process.argv.slice(2); const option = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; }; const query = option('all'); const task = option('task') || ''; const requested = option('get');
if (!query && !requested) throw new Error('Usage: --all "keywords" [--task "task"] | --get "name1,name2"');
const build = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build-index.mjs');
if (!fs.existsSync(CATALOG)) {
  if (requested) throw new Error('No catalog yet. Run a --all search first.');
  console.error('Catalog missing — building it now (HTTP only, no model call).');
  try { execFileSync(process.execPath, [build], { stdio: 'inherit' }); }
  catch (error) { throw new Error(`Catalog build failed: ${error.message}`); }
}
else if (query && stale()) {
  console.error('Catalog is stale — serving it now and refreshing in the background.');
  const refresh = spawn(process.execPath, [build], { detached: true, stdio: 'ignore' });
  refresh.on('error', (error) => console.error(`Background catalog refresh failed to start: ${error.message}`));
  refresh.unref();
}
function stale() { try { return Date.now() - Date.parse(JSON.parse(fs.readFileSync(META, 'utf8')).builtAt) > 7 * 24 * 60 * 60 * 1000; } catch { return true; } }
const docs = fs.readFileSync(CATALOG, 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
if (requested) { const names = new Set(requested.split(',').map((name) => name.trim().toLowerCase())); console.log(JSON.stringify(docs.filter((doc) => names.has((doc.name || '').toLowerCase())).map(({ fulltext, ...doc }) => doc), null, 2)); process.exit(0); }
const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'with']);
const tokenize = (text) => (String(text).toLowerCase().match(/[a-z0-9][a-z0-9+.#/-]*/g) || []).filter((token) => token.length > 1 && !STOP_WORDS.has(token));
const keywordTokens = [...new Set(tokenize(query))]; const taskTokens = [...new Set(tokenize(task))].filter((token) => !keywordTokens.includes(token)); const tokens = [...keywordTokens, ...taskTokens];
const fields = docs.map((doc) => ({ name: new Set(tokenize(doc.name)), tags: new Set(tokenize((doc.tags || []).join(' '))), description: new Set(tokenize(doc.description)), body: new Set(tokenize(doc.fulltext || '')) }));
const frequency = new Map(tokens.map((token) => [token, fields.reduce((count, field) => count + Number(Object.values(field).some((set) => set.has(token))), 0)])); const idf = (token) => Math.log(1 + docs.length / (1 + (frequency.get(token) || 0)));
let scored = docs.map((doc, index) => { const field = fields[index]; const matches = []; let score = 0; for (const token of tokens) { const weight = field.name.has(token) ? 3 : field.tags.has(token) ? 2 : field.description.has(token) ? 1 : field.body.has(token) ? .5 : 0; if (weight) { score += weight * idf(token); matches.push(`${token}:${weight === 3 ? 'name' : weight === 2 ? 'tag' : weight === 1 ? 'description' : 'body'}`); } } return { doc, score, matches }; }).filter((result) => result.score > 0).sort((a, b) => b.score - a.score);
const config = loadConfig(); const provider = resolveProvider(config); let mode = config.fulltext === false ? 'lexical(lite)' : 'lexical+fulltext'; const vector = provider && !provider.missingKey ? readVectors(docs.length) : null;
if (vector) try { const [queryVector] = await embedTexts([task || query], provider); if (queryVector.length !== vector.meta.dims) throw new Error(`stored vectors have ${vector.meta.dims} dims but ${provider.name}/${provider.model} produced ${queryVector.length}; rebuild the catalog`); const semantic = docs.map((_, i) => { let score = 0; for (let j = 0; j < vector.meta.dims; j += 1) score += vector.data[i * vector.meta.dims + j] * queryVector[j]; return { i, score }; }).sort((a, b) => b.score - a.score); const fused = new Map(); scored.slice(0, 100).forEach((row, i) => fused.set(row.doc, { ...row, score: 1 / (60 + i) })); semantic.slice(0, 100).forEach((row, i) => { const previous = fused.get(docs[row.i]) || { doc: docs[row.i], matches: [], score: 0 }; fused.set(docs[row.i], { ...previous, score: previous.score + 1 / (60 + i) }); }); scored = [...fused.values()].sort((a, b) => b.score - a.score); mode += ` + vector RRF(${vector.meta.provider}/${vector.meta.model})`; } catch (error) { console.error(`Vector search failed; lexical results retained: ${error.message}`); }
const caps = { skill: 6, plugin: 5, mcp: 5 }; const byKind = new Map(); for (const row of scored) { if (!byKind.has(row.doc.kind)) byKind.set(row.doc.kind, []); byKind.get(row.doc.kind).push(row); }
let meta = {}; try { meta = JSON.parse(fs.readFileSync(META, 'utf8')); } catch { /* current catalog remains usable */ }
console.log(`# catalog: ${meta.builtAt || 'unknown'} (${meta.total || docs.length} entries)`); console.log(`# mode: ${mode}`); console.log(`# query: keywords[${keywordTokens.join(' ')}]${taskTokens.length ? ` + task[${taskTokens.join(' ')}]` : ''}`); console.log(`# hits: ${Object.keys(caps).map((kind) => `${kind} ${(byKind.get(kind) || []).length} → ${Math.min(caps[kind], (byKind.get(kind) || []).length)}`).join(' / ')}`); console.log('kind\tname\tsource\tmatched_fields\tdescription');
for (const kind of Object.keys(caps)) for (const row of (byKind.get(kind) || []).slice(0, caps[kind])) console.log(`${row.doc.kind}\t${row.doc.name}\t${row.doc.source}\t${row.matches.join(',')}\t${(row.doc.description || '').replace(/[\t\n]/g, ' ').slice(0, 110)}`);
