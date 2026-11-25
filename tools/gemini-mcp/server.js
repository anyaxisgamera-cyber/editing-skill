#!/usr/bin/env node
'use strict';
// Minimal MCP stdio server for the Google AI Studio (Gemini) API.
// No dependencies. The API key is never stored here and never logged:
//  - preferred: the cloud proxy injects it as the x-goog-api-key header
//    (Network secret for generativelanguage.googleapis.com), so we send a placeholder;
//  - fallback: GEMINI_API_KEY from the environment.

const API = 'https://generativelanguage.googleapis.com/v1beta';
const KEY = process.env.GEMINI_API_KEY || 'proxy-injected';
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 120000);
let cachedModels = null;

const log = (...a) => process.stderr.write('[gemini-mcp] ' + a.join(' ') + '\n');

async function call(path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-goog-api-key': KEY, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    if (!res.ok) {
      const msg = json?.error?.message || text.slice(0, 300);
      const hint = { 400: 'bad request or invalid API key', 401: 'not authenticated', 403: 'key lacks access or API not enabled',
        404: 'model not found (run gemini_list_models)', 429: 'rate limit / quota exceeded' }[res.status] || 'Gemini API error';
      throw new Error(`HTTP ${res.status} (${hint}): ${msg}`);
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`timed out after ${TIMEOUT_MS} ms`);
    throw e;
  } finally { clearTimeout(t); }
}

async function listModels() {
  if (cachedModels) return cachedModels;
  const out = []; let token = '';
  do {
    const j = await call('/models?pageSize=1000' + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
    out.push(...(j.models || []));
    token = j.nextPageToken || '';
  } while (token);
  cachedModels = out.filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => ({ id: m.name.replace(/^models\//, ''), name: m.displayName, input_tokens: m.inputTokenLimit, output_tokens: m.outputTokenLimit }));
  return cachedModels;
}

async function defaultModel() {
  if (process.env.GEMINI_DEFAULT_MODEL) return process.env.GEMINI_DEFAULT_MODEL;
  const ids = (await listModels()).map(m => m.id)
    .filter(id => /^gemini-\d/.test(id) && !/(exp|preview|tts|image|live|embedding|audio|lite)/.test(id));
  const ver = id => parseFloat(id.match(/^gemini-(\d+(?:\.\d+)?)/)[1]);
  ids.sort((a, b) => ver(b) - ver(a));
  return ids.find(id => /-flash$/.test(id)) || ids.find(id => /-pro$/.test(id)) || ids[0];
}

async function ask(args) {
  if (!args || typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('"prompt" is required');
  const model = args.model || await defaultModel();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error('invalid model id');
  const body = { contents: [{ role: 'user', parts: [{ text: args.prompt }] }], generationConfig: {} };
  if (args.system) body.systemInstruction = { parts: [{ text: args.system }] };
  if (args.temperature !== undefined) body.generationConfig.temperature = args.temperature;
  if (args.max_output_tokens) body.generationConfig.maxOutputTokens = args.max_output_tokens;
  const j = await call(`/models/${model}:generateContent`, body);
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts || []).map(p => p.text || '').join('');
  if (!text) throw new Error(`empty response (finishReason=${cand?.finishReason || 'none'}, block=${j.promptFeedback?.blockReason || 'none'})`);
  const u = j.usageMetadata || {};
  return `${text}\n\n— model: ${j.modelVersion || model} | tokens in/out: ${u.promptTokenCount ?? '?'}/${u.candidatesTokenCount ?? '?'}`;
}

const TOOLS = [
  { name: 'gemini_ask', description: 'Send a prompt to a Google Gemini model (Google AI Studio API) and return its answer. Use when the user asks for Gemini or a second opinion from Gemini.',
    inputSchema: { type: 'object', required: ['prompt'], properties: {
      prompt: { type: 'string', description: 'The full prompt. Only include project code the user agreed to share with Gemini.' },
      model: { type: 'string', description: 'Gemini model id, e.g. from gemini_list_models. Defaults to the newest stable Flash model.' },
      system: { type: 'string', description: 'Optional system instruction.' },
      temperature: { type: 'number' }, max_output_tokens: { type: 'integer' } } } },
  { name: 'gemini_list_models', description: 'List Gemini models available to this API key that support text generation.',
    inputSchema: { type: 'object', properties: {} } },
];

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') return { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'gemini', version: '1.0.0' } };
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') {
    try {
      let text;
      if (params.name === 'gemini_ask') text = await ask(params.arguments);
      else if (params.name === 'gemini_list_models') {
        const models = await listModels();
        text = `default: ${await defaultModel()}\n` + models.map(m => `${m.id}  (${m.name}; in ${m.input_tokens}, out ${m.output_tokens})`).join('\n');
      } else throw new Error('unknown tool ' + params.name);
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      log('tool error:', e.message);
      return { content: [{ type: 'text', text: 'Gemini error: ' + e.message }], isError: true };
    }
  }
  if (id !== undefined) throw Object.assign(new Error('method not found: ' + method), { code: -32601 });
  return undefined;
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { log('bad JSON line ignored'); continue; }
    handle(msg).then(result => {
      if (msg.id !== undefined && result !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    }).catch(e => {
      if (msg.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message } }) + '\n');
    });
  }
});
