import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { prepare, responseModel, readSwitch } from './agnes-model-routing-runtime.mjs';
import { install, status, setEnabled, uninstall, extractFunction, patchBundle, ORIGINAL_HASHES } from './agnes-model-routing.mjs';

const ciDir = process.env.AGNES_ROUTING_CI_DIR;
const output = process.env.AGNES_ROUTING_EVIDENCE_DIR;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agnes-routing-test-'));
process.on('exit', () => fs.rmSync(tempRoot, { recursive: true, force: true }));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const model = () => ({ id: 'gpt-6-astra', provider: 'openai-codex',
  api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api',
  reasoning: true, contextWindow: 272000, maxTokens: 128000,
  thinkingLevelMap: { high: 'high', off: 'none' }, cost: {}, input: ['text', 'image'] });
const makeDir = (name) => { const dir = path.join(tempRoot, name); fs.mkdirSync(dir); return dir; };
const copyCi = (dir) => {
  for (const name of Object.keys(ORIGINAL_HASHES)) fs.copyFileSync(path.join(ciDir, name), path.join(dir, name));
};
const clean = (value) => JSON.parse(JSON.stringify(value));

test('enabled routing keeps the selected object intact and uses the real 6.1 ID on the wire', () => {
  const original = model(), options = { reasoningEffort: 'high', maxTokens: 64000, apiKey: 'DUMMY_ONLY' };
  const before = structuredClone(original), priorOptions = structuredClone(options);
  const routed = prepare(original, options, true);
  assert.equal(routed.model.id, 'gpt-6.1-sol');
  assert.equal(routed.model.provider, original.provider);
  assert.equal(routed.model.baseUrl, original.baseUrl);
  assert.equal(routed.options.apiKey, options.apiKey);
  assert.equal(responseModel(original, 'gpt-6.1-sol'), 'gpt-6-astra');
  assert.equal(responseModel(original, undefined), undefined);
  assert.deepEqual(original, before); assert.deepEqual(options, priorOptions);
});

test('off and unrelated providers retain original call and response metadata', () => {
  const original = model(); prepare(original, {}, true);
  const off = prepare(original, {}, false);
  assert.equal(off.model, original); assert.equal(responseModel(original, 'server-model'), 'server-model');
  for (const other of [{ ...model(), api: 'openai-responses' },
    { ...model(), provider: 'different' }, { ...model(), baseUrl: 'https://example.invalid' }]) {
    assert.equal(prepare(other, {}, true).model, other);
    assert.equal(responseModel(other, 'server-model'), 'server-model');
  }
});

test('concurrent selected models retain independent model aliases', () => {
  const astra = model(), sol = { ...model(), id: 'gpt-6-sol' };
  prepare(astra, {}, true); prepare(sol, {}, true);
  assert.equal(responseModel(astra, 'gpt-6.1-sol'), 'gpt-6-astra');
  assert.equal(responseModel(sol, 'gpt-6.1-sol'), 'gpt-6-sol');
  prepare(astra, {}, false);
  assert.equal(responseModel(astra, 'gpt-6-astra-snapshot'), 'gpt-6-astra-snapshot');
  assert.equal(responseModel(sol, 'gpt-6.1-sol'), 'gpt-6-sol');
});

test('6.1 reasoning efforts and output limits are valid without changing UI settings', () => {
  for (const effort of [undefined, 'none', 'minimal']) {
    assert.equal(prepare(model(), { reasoningEffort: effort }, true).options.reasoningEffort, 'low');
  }
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'])
    assert.equal(prepare(model(), { reasoningEffort: effort }, true).options.reasoningEffort, effort);
  assert.equal(prepare(model(), { maxTokens: 999999 }, true).options.maxTokens, 128000);
  assert.throws(() => prepare(model(), { reasoningEffort: 'ultra' }, true), /Unsupported/);
});

test('switch changes apply to the next call, and invalid switches fail instead of silently calling Astra', () => {
  const dir = makeDir('switch'); const file = path.join(dir, 'switch.json');
  assert.equal(readSwitch(file), false);
  fs.writeFileSync(file, '{"version":1,"enabled":true}'); assert.equal(readSwitch(file), true);
  fs.writeFileSync(file, '{"version":1,"enabled":false}'); assert.equal(readSwitch(file), false);
  fs.writeFileSync(file, '{"version":1,"enabled":"false"}'); assert.throws(() => readSwitch(file), /unsupported/);
  fs.writeFileSync(file, '{broken'); assert.throws(() => readSwitch(file), /valid JSON/);
});

test('unknown bundles are refused before any file or account configuration is changed', () => {
  const dir = makeDir('unknown');
  fs.writeFileSync(path.join(dir, 'worker.mjs'), 'not the reviewed CI');
  fs.writeFileSync(path.join(dir, 'daemon.mjs'), 'not the reviewed CI');
  const before = fs.readFileSync(path.join(dir, 'worker.mjs'));
  assert.throws(() => install({ dir, home: tempRoot }, {}), /reviewed Windows CI/);
  assert.equal(fs.readFileSync(path.join(dir, 'worker.mjs')).compare(before), 0);
  assert.equal(fs.existsSync(path.join(dir, 'agnes-model-routing-backup')), false);
});

test('install, on/off, normal account preservation and uninstall work on the exact CI', { skip: !ciDir }, () => {
  const dir = makeDir('install'); copyCi(dir);
  const home = makeDir('home'); const profile = path.join(home, 'profiles', 'local-dev');
  fs.mkdirSync(profile, { recursive: true });
  const accounts = '{"version":2,"accounts":[{"id":"openai-codex","models":["gpt-6-astra","gpt-6-sol"]}]}';
  fs.writeFileSync(path.join(profile, 'configuration.json'), accounts);
  install({ dir, home, enabled: true }, {}); assert.equal(status({ dir }).enabled, true);
  assert.equal(fs.readFileSync(path.join(profile, 'configuration.json'), 'utf8'), accounts);
  install({ dir, home, enabled: false }, {}); assert.equal(status({ dir }).enabled, false);
  install({ dir, home, enabled: true }, {}); assert.equal(status({ dir }).enabled, true);
  uninstall({ dir }); assert.equal(status({ dir }).installed, false);
  for (const [name, hash] of Object.entries(ORIGINAL_HASHES)) assert.equal(digest(fs.readFileSync(path.join(dir, name))), hash);
  install({ dir, home, enabled: false }, {}); uninstall({ dir });
});

test('a changed sidecar is preserved and refused rather than overwritten', { skip: !ciDir }, () => {
  const dir = makeDir('changed'); copyCi(dir); install({ dir, home: tempRoot }, {});
  fs.appendFileSync(path.join(dir, 'worker.mjs'), '\n// unrelated local change\n');
  assert.throws(() => install({ dir, home: tempRoot, enabled: false }, {}), /changed after installation/);
  assert.throws(() => uninstall({ dir }), /changed after installation/);
  assert(fs.readFileSync(path.join(dir, 'worker.mjs'), 'utf8').endsWith('// unrelated local change\n'));
});

test('the previous one-model profile is restored byte for byte before enabling aliases', { skip: !ciDir }, () => {
  const dir = makeDir('migration'); copyCi(dir);
  const home = makeDir('old-home'), profile = path.join(home, 'profiles', 'local-dev');
  fs.mkdirSync(profile, { recursive: true });
  const original = Buffer.from('{"version":2,"accounts":["synthetic-astra","synthetic-sol"]}\n');
  const manual = Buffer.from('{"provider":{"routes":[{"models":[{"id":"gpt-6.1-sol"}]}]}}\n');
  fs.writeFileSync(path.join(profile, 'profile.yaml'), manual);
  fs.writeFileSync(path.join(profile, 'configuration.json.saved'), original);
  fs.writeFileSync(path.join(profile, 'gpt61-sol-manual-profile.json'), JSON.stringify({ version: 1,
    generatedHash: digest(manual), configBackup: 'configuration.json.saved', configHash: digest(original),
    profileBackup: null, profileHash: null }));
  const result = install({ dir, home }, {}); assert.equal(result.manualProfileRestored, true);
  assert.equal(fs.readFileSync(path.join(profile, 'configuration.json')).compare(original), 0);
  assert.equal(fs.existsSync(path.join(profile, 'profile.yaml')), false);
  // A user may click Off before installing the new version: restore the old profile without patching.
  uninstall({ dir });
  fs.renameSync(path.join(profile, 'configuration.json'), path.join(profile, 'configuration.json.saved'));
  fs.writeFileSync(path.join(profile, 'profile.yaml'), manual);
  fs.writeFileSync(path.join(profile, 'gpt61-sol-manual-profile.json'), JSON.stringify({ version: 1,
    generatedHash: digest(manual), configBackup: 'configuration.json.saved', configHash: digest(original),
    profileBackup: null, profileHash: null }));
  const off = setEnabled({ dir, home, enabled: false }, {});
  assert.equal(off.installed, false); assert.equal(off.manualProfileRestored, true);
  assert.equal(fs.readFileSync(path.join(profile, 'configuration.json')).compare(original), 0);
  for (const [name, hash] of Object.entries(ORIGINAL_HASHES)) assert.equal(digest(fs.readFileSync(path.join(dir, name))), hash);
});

test('changed prior profile blocks migration without patching the CI', { skip: !ciDir }, () => {
  const dir = makeDir('refused-migration'); copyCi(dir);
  const home = makeDir('modified-old-home'), profile = path.join(home, 'profiles', 'local-dev');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'profile.yaml'), 'unrelated changes');
  fs.writeFileSync(path.join(profile, 'gpt61-sol-manual-profile.json'), JSON.stringify({ version: 1,
    generatedHash: '0'.repeat(64) }));
  assert.throws(() => install({ dir, home }, {}), /previous manual profile changed/);
  for (const [name, hash] of Object.entries(ORIGINAL_HASHES)) assert.equal(digest(fs.readFileSync(path.join(dir, name))), hash);
  assert.equal(fs.existsSync(path.join(dir, 'agnes-model-routing-backup')), false);
});

test('actual CI adapter events and request-header formats match Astra while only the sent model changes', { skip: !ciDir }, async () => {
  const dir = makeDir('comparison'); copyCi(dir); install({ dir, home: tempRoot }, {});
  const alias = await import(pathToFileURL(path.join(dir, 'agnes-model-routing-runtime.mjs')).href);
  const original = fs.readFileSync(path.join(ciDir, 'worker.mjs'), 'utf8');
  const patched = fs.readFileSync(path.join(dir, 'worker.mjs'), 'utf8');
  assert.equal(patched, patchBundle(original));
  const catalogMatch = /^    openai_codex_default = (.*);$/m.exec(original);
  const catalog = vm.runInNewContext(`(${catalogMatch[1]})`);
  const astra = clean(catalog['openai-codex-responses']['gpt-6-astra']);
  const record = { ...astra, route: 'account-synthetic-astra', toolCallFormats: ['native'],
    thinkingReplay: 'native', contract_id: null };
  record.thinkingLevelMap = Object.fromEntries(Object.entries(astra.thinkingLevelMap).filter(([, value]) => typeof value === 'string'));
  delete record.provider; delete record.inputLimits; record.cost = { input: astra.cost.input,
    output: astra.cost.output, cacheRead: astra.cost.cacheRead, cacheWrite: astra.cost.cacheWrite };

  async function run(source, enabled) {
    fs.writeFileSync(path.join(dir, 'agnes-model-routing.json'), JSON.stringify({ version: 1, enabled }));
    let captured, sent;
    const sandbox = { __agnesModelRouting: alias, structuredClone, setTimeout, clearTimeout,
      Request, Response, URL, TextEncoder, TextDecoder, Uint8Array, AbortController, performance,
      RETRY_BASE_MS: 500, ABORTED: Symbol('aborted'), AMBIENT_CREDENTIAL_APIS: new Set(['bedrock-converse-stream', 'google-vertex']),
      AGNES_AI_BASE_URL: 'https://agnes.example.invalid', DEFAULT_CODEX_BASE_URL: astra.baseUrl,
      sha256Hex: digest, sha256Hex2: digest, isUsableCredential: (value) => !!value?.trim(),
      AiSetupError: Error, CoreError: Error,
      NONCE_PATTERN: /^[a-f0-9]{32,64}$/, KINDS: new Set(['turn', 'summary']),
      THINKING_LEVELS: new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
      // Synthetic empty-history context seams; the actual header construction stays unchanged.
      UNTRUSTED_RULE_SECTION: { id: 'core:untrusted', order: 0, text: 'Synthetic test context', source: 'core' },
      harnessSections: () => [], scrubOnce: (value) => value, RUNTIME_CONTEXT_PREFIX: '[runtime context]\n',
      lastRuntimeContextText: () => '', minted: new WeakSet(),
      toContext: (request) => ({ context: { messages: request.messages } }), normalizeContext: (context) => context,
      CODEX_TOOL_CALL_PROVIDERS: new Set(['openai-codex']),
      createGrammarToolInputProperties: () => ({}), getDeclaredTools: () => [],
      resolveTranscriptTools: () => ({ requestTools: [] }),
      convertResponsesMessages: () => [{ role: 'user', content: [{ type: 'input_text', text: 'Offline synthetic comparison' }] }],
      getInitialSystemMessage: () => undefined, getSystemMessageText: () => '', isContextOverflow: () => false,
      // Route/decode/validation seams use fixed synthetic inputs; the public facade is original CI code.
      resolveSelection: () => ({ route: record.route, model: record }), SlotUnresolved: Error,
      createState2: () => ({}), finish2: (state) => ({ state, events: [] }),
      step: (state, input) => ({ state, events: [{ type: `${input.kind}_delta`, delta: input.delta }] }),
      ResponseMeta2: {}, validateAgainst: () => ({ ok: true }),
      DEFAULT_TIMEOUT: { firstToken: 5000, total: 10000 },
      HEADER_VALUES: new Set(['x-request-id', 'server']),
      TABLE: [[/401|unauthorized/, 'AUTH', false]],
      async fetch(request) {
        captured = JSON.parse(await request.text());
        assert.equal(request.url, 'https://chatgpt.com/backend-api/codex/responses');
        return new Response(JSON.stringify({ model: captured.model }), { headers: { 'x-request-id': 'req_synthetic', server: 'synthetic' } });
      },
      APIS: { 'openai-codex-responses': () => ({ stream: async function* (wireModel, context, options) {
        const body = sandbox.buildRequestBody(wireModel, context, options, 'synthetic-cache-key');
        const response = await options.fetch(sandbox.resolveCodexUrl(wireModel.baseUrl), {
          method: 'POST', body: JSON.stringify(body), headers: { authorization: 'Bearer DUMMY_SYNTHETIC_ONLY' } });
        const supplied = await response.json();
        yield { type: 'thinking_delta', delta: 'Synthetic reasoning.' };
        yield { type: 'text_delta', delta: '离线示例回答。' };
        yield { type: 'toolcall_end', toolCall: { id: 'call_synthetic', name: 'synthetic_tool', arguments: { value: 1 } } };
        yield { type: 'done', reason: 'stop', message: { responseId: 'resp_synthetic', responseModel: supplied.model,
          usage: { input: 120, output: 30, cacheRead: 10, cacheWrite: 0, reasoning: 5 } } };
      } }) },
    };
    const context = vm.createContext(sandbox);
    const functions = ['requireAbsoluteHttpUrl', 'toPiModel', 'abortPromise', 'streamOverApi',
      'translateEvent', 'responseMeta', 'withResponse', 'classifyPiError', 'redact2', 'retryAfterMs',
      'buildRequestBody', 'resolveCodexUrl', 'deriveRequest', 'assertNonce', 'assertKind', 'assertThinking',
      'canonicalJson', 'sanitize', 'sanitizeJson', 'mintFrom', 'hashDerivedRequest', 'deepFreeze',
      'runInference2', 'buildStamp', 'renderPrefixedPrompt', 'toolSchemaHash', 'checkedResponse',
      'estimateCredits', 'estimateBilling'];
    const chunks = functions.map((name) => extractFunction(source, name).text);
    for (const name of ['WireAdapter', 'PiAdapter']) {
      const start = source.indexOf(`    ${name} = class`), end = source.indexOf('\n    };', start) + 7;
      chunks.push(source.slice(start, end));
    }
    vm.runInContext('var WireAdapter, PiAdapter;\n' + chunks.join('\n'), context);
    sandbox.canonicalJson3 = sandbox.canonicalJson;
    const header = sandbox.deriveRequest({ kind: 'turn', nonce: 'a'.repeat(32), harnessEntries: [], surface: [], disclosed: [],
      envelopeNonceFor: () => undefined, merged: { sections: [], runtimeContext: {}, tools: [] },
      model: { slot: 'primary', route: record.route, model: record.id, thinking: 'high' },
      contract: { contract_id: null, parser_version: '2' } }).header;
    const route = { route: record.route, api: record.api, baseUrl: record.baseUrl,
      credentialRef: 'secret://openai-codex/account-synthetic-astra', models: [record] };
    const adapter = vm.runInContext('PiAdapter', context);
    const instance = new adapter({ providerId: 'openai-codex', manualRoutes: [route],
      resolveCredential: async () => ({ apiKey: 'DUMMY_SYNTHETIC_ONLY' }) });
    const events = [];
    let clock = 0;
    for await (const event of sandbox.runInference2({ registry: { lookup: () => ({ adapter: instance }) },
      contract: { prefixHash: () => null }, parserVersion: '2', creditsPerUsd: 1, clock: () => clock++ },
      { kind: 'inference', sessionKey: 'synthetic-session',
      slot: 'primary', route: record.route, model: record.id, system: 'Synthetic comparison',
      messages: [], tools: [], derivedHash: header.derived_hash, contractId: null,
      timeoutMs: { firstToken: 5000, total: 10000 }, sampling: { thinking: 'high' } },
      { signal: new AbortController().signal, toolNames: ['synthetic_tool'] })) events.push(clean(event));
    assert.equal(events.at(-1).type, 'done');
    sent = { sentHash: events[0].stamp.sent_hash, transforms: events[0].stamp.transforms };
    assert.equal(events[0].stamp.model.id, 'gpt-6-astra');
    const response = events.find((event) => event.type === 'usage').response;
    const requestModel = sandbox.toPiModel(route, record); requestModel.provider = 'openai-codex';
    alias.prepare(requestModel, {}, enabled);
    const error = sandbox.translateEvent({ type: 'error', reason: 'error', error: {
      stopReason: 'error', errorMessage: '401 unauthorized', responseId: 'req_synthetic',
      responseModel: captured.model } }, requestModel, () => 0, {});
    return { header: clean(header), events, sent: clean(sent), captured, response, error: clean(error) };
  }
  const baseline = await run(original, false), on = await run(patched, true), off = await run(patched, false);
  assert.deepEqual(on.header, baseline.header); assert.deepEqual(off.header, baseline.header);
  const omitDynamicHash = (events) => {
    const copy = structuredClone(events); copy[0].stamp.sent_hash = '(actual request hash)'; return copy;
  };
  assert.deepEqual(omitDynamicHash(on.events), omitDynamicHash(baseline.events));
  assert.deepEqual(off.events, baseline.events);
  assert.deepEqual(on.error, baseline.error); assert.deepEqual(off.error, baseline.error);
  assert.equal(baseline.captured.model, 'gpt-6-astra'); assert.equal(on.captured.model, 'gpt-6.1-sol');
  assert.equal(off.captured.model, 'gpt-6-astra'); assert.equal(on.response.model, 'gpt-6-astra');
  assert.notEqual(on.sent.sentHash, baseline.sent.sentHash); assert.equal(off.sent.sentHash, baseline.sent.sentHash);
  assert.deepEqual({ ...on.captured, model: baseline.captured.model }, baseline.captured);
  assert.deepEqual(on.sent.transforms, baseline.sent.transforms);
  for (const name of Object.keys(ORIGINAL_HASHES)) {
    const changed = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.equal(changed, patchBundle(fs.readFileSync(path.join(ciDir, name), 'utf8')));
  }
  if (output) {
    fs.mkdirSync(output, { recursive: true });
    for (const [name, sample] of [['原版-Astra', baseline], ['开启-实际6.1', on], ['关闭-Astra', off]]) {
      fs.writeFileSync(path.join(output, `${name}-模型事件.jsonl`), sample.events.map((event) => JSON.stringify(event)).join('\n') + '\n');
      fs.writeFileSync(path.join(output, `${name}-请求头.json`), JSON.stringify(sample.header, null, 2) + '\n');
      fs.writeFileSync(path.join(output, `${name}-错误事件.jsonl`), sample.error.map((event) => JSON.stringify(event)).join('\n') + '\n');
      fs.writeFileSync(path.join(output, `${name}-发送内容.json`), JSON.stringify({ request: sample.captured, sent: sample.sent }, null, 2) + '\n');
    }
    fs.writeFileSync(path.join(output, '对比结果.json'), JSON.stringify({ passed: true, ciRun: '37262837798',
      inputSelectedModel: 'gpt-6-astra', onActualRequestModel: on.captured.model, offActualRequestModel: off.captured.model,
      headerByteEquivalentForFixedFixture: true, publicInferenceEventFormatIdentical: true,
      inferenceEventsEqualExceptActualSentHashForFixedFixture: true,
      errorEventByteEquivalentForFixedFixture: true, noNewEventFields: true, sentHashReflectsChangedRequest: true,
      originalRestorationTested: true, legacyProfileMigrationTested: true,
      testEnvironment: 'Linux ARM64, Node 24.21.0; official Windows CI functions, mock HTTP transport and synthetic fixtures',
      realAccountCalls: false, fullWindowsDaemonAndSQLiteExportTested: false }, null, 2) + '\n');
  }
});
