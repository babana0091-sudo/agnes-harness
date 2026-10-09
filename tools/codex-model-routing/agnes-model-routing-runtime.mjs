// Local Codex model aliases. Keep session metadata on the UI-selected model.
// This module reads only its tiny routing switch, never account credentials.
import { readFileSync } from 'node:fs';

const switchFile = new URL('./agnes-model-routing.json', import.meta.url);
const aliases = new WeakMap();
const supportedEfforts = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function readSwitch(file = switchFile) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error('Cannot read the local Codex routing switch.');
  }
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new Error('The local Codex routing switch is not valid JSON.'); }
  if (!value || value.version !== 1 || typeof value.enabled !== 'boolean' ||
      Object.keys(value).some((key) => !['version', 'enabled'].includes(key)))
    throw new Error('The local Codex routing switch has an unsupported format.');
  return value.enabled;
}

export function prepare(model, options, enabled) {
  aliases.delete(model);
  if (model.api !== 'openai-codex-responses' || model.provider !== 'openai-codex' ||
      model.baseUrl?.replace(/\/+$/, '') !== 'https://chatgpt.com/backend-api')
    return { model, options };
  if (!(enabled === undefined ? readSwitch() : enabled)) return { model, options };
  const requestedEffort = options?.reasoningEffort;
  const effort = requestedEffort === undefined || ['none', 'minimal'].includes(requestedEffort)
    ? 'low' : requestedEffort;
  if (!supportedEfforts.has(effort)) throw new Error('Unsupported GPT-6.1-Sol reasoning effort.');
  aliases.set(model, model.id);
  return {
    model: {
      ...model, id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium',
        high: 'high', xhigh: 'xhigh', max: 'max' },
      contextWindow: 272000, maxTokens: 128000,
      cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    },
    options: { ...options, reasoningEffort: effort,
      ...(options?.maxTokens === undefined ? {} : { maxTokens: Math.min(options.maxTokens, 128000) }) },
  };
}

// Keep the existing optional field optional. Other response facts remain untouched.
export function responseModel(model, supplied) {
  return supplied ? aliases.get(model) ?? supplied : supplied;
}
