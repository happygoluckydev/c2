// SPDX-License-Identifier: MIT
// Preloaded with --import to serve build-index.mjs's catalog sources from a fixture file instead of
// the network. C2_TEST_ROUTES points at a JSON array of routes, first match wins:
//   [{ "match": "<url substring>", "json": {...} | "text": "..." | "embed": <dims>, "status": 500 }]
// An unmatched request answers HTTP 404, which build-index records as a source error.
import fs from 'node:fs';

const routes = JSON.parse(fs.readFileSync(process.env.C2_TEST_ROUTES, 'utf8'));

globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const route = routes.find((candidate) => url.includes(candidate.match));
    if (!route || route.status) {
        return { ok: false, status: route ? route.status : 404, text: async () => 'error', json: async () => ({}) };
    }
    if (route.embed) {
        const { input: texts } = JSON.parse(init.body);
        const data = texts.map((_, index) => ({ embedding: Array.from({ length: route.embed }, (_, i) => (i === index % route.embed ? 1 : 0)) }));
        return { ok: true, status: 200, json: async () => ({ data }), text: async () => JSON.stringify({ data }) };
    }
    const body = 'text' in route ? route.text : JSON.stringify(route.json);
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
};
