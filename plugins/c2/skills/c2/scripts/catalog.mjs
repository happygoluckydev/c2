import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const DATA_DIR = path.join(CODEX_HOME, 'c2');
export const CATALOG = path.join(DATA_DIR, 'catalog.jsonl');
export const META = path.join(DATA_DIR, 'meta.json');
export const VEC_BIN = path.join(DATA_DIR, 'vectors.bin');
export const VEC_META = path.join(DATA_DIR, 'vectors.json');
const CONFIG = path.join(DATA_DIR, 'config.json');
const DEFAULTS = { fulltext: true, vectors: { provider: 'none' } };

export function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const result = { fmLen: match ? match[0].length : 0, body: (match ? text.slice(match[0].length) : text).trim() };
  for (const line of (match?.[1] || '').split(/\r?\n/)) {
    const field = line.match(/^(name|description)\s*:\s*(.*)$/);
    if (field) result[field[1]] = field[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return result;
}
export const clipped = (text = '') => text.replace(/\0/g, '').slice(0, 4000);
export function walk(root, predicate) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const visit = (dir) => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.name === '.git' || item.name === 'node_modules') continue;
    const file = path.join(dir, item.name);
    if (item.isDirectory()) visit(file); else if (predicate(file)) files.push(file);
  }};
  visit(root); return files;
}
export function loadConfig() { try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')) }; } catch { return DEFAULTS; } }
const openAIStyle = (url) => ({ request: (input, p) => [url, { Authorization: `Bearer ${p.key}` }, { model: p.model, input }], extract: (body) => body.data.map((row) => row.embedding) });
const PROVIDERS = {
  gemini: { keyEnv: 'GEMINI_API_KEY', model: 'text-embedding-004', batch: 100, request: (input, p) => [`https://generativelanguage.googleapis.com/v1beta/models/${p.model}:batchEmbedContents?key=${p.key}`, {}, { requests: input.map((text) => ({ model: `models/${p.model}`, content: { parts: [{ text }] } })) }], extract: (body) => body.embeddings.map((row) => row.values) },
  voyage: { keyEnv: 'VOYAGE_API_KEY', model: 'voyage-3.5-lite', batch: 128, ...openAIStyle('https://api.voyageai.com/v1/embeddings') },
  openai: { keyEnv: 'OPENAI_API_KEY', model: 'text-embedding-3-small', batch: 256, ...openAIStyle('https://api.openai.com/v1/embeddings') },
};
export function resolveProvider(config) {
  const selection = config.vectors || {}; if (!selection.provider || selection.provider === 'none') return null;
  const provider = PROVIDERS[selection.provider]; if (!provider) throw new Error(`Unknown vector provider: ${selection.provider}`);
  const keyEnv = selection.apiKeyEnv || provider.keyEnv; const key = process.env[keyEnv];
  return key ? { name: selection.provider, key, model: selection.model || provider.model, batch: provider.batch, request: provider.request, extract: provider.extract } : { name: selection.provider, missingKey: keyEnv };
}
const normalize = (vector) => { const magnitude = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0)) || 1; return vector.map((n) => n / magnitude); };
export async function embedTexts(texts, provider) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += provider.batch) {
    const [url, headers, body] = provider.request(texts.slice(i, i + provider.batch), provider);
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Embedding API HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    for (const vector of provider.extract(await response.json())) vectors.push(normalize(vector));
  }
  return vectors;
}
export function writeVectors(vectors, meta) { const dims = vectors[0]?.length || 0; const data = new Float32Array(vectors.length * dims); vectors.forEach((v, i) => data.set(v, i * dims)); fs.writeFileSync(VEC_BIN, Buffer.from(data.buffer)); fs.writeFileSync(VEC_META, JSON.stringify({ ...meta, dims, count: vectors.length })); }
export function readVectors(count) { try { const meta = JSON.parse(fs.readFileSync(VEC_META, 'utf8')); if (!meta.dims || meta.count !== count) return null; const data = fs.readFileSync(VEC_BIN); return { meta, data: new Float32Array(data.buffer, data.byteOffset, data.length / 4) }; } catch { return null; } }
