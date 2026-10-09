// Installer for the reviewed Windows CI sidecars. No network or credential access.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSwitch } from './agnes-model-routing-runtime.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ORIGINAL_HASHES = {
  'worker.mjs': 'd0b947cb5f18955bbc1048c6e159374e30f76c2d6b9d1494879a2f772015ac11',
  'daemon.mjs': 'eada75c45461262be82234a2058ba9a3547ca6b845982991f594bde0c8c5bf5d',
};
const RUNTIME = 'agnes-model-routing-runtime.mjs';
const STATE = 'agnes-model-routing-install.json';
const SWITCH = 'agnes-model-routing.json';
const BACKUP_DIR = 'agnes-model-routing-backup';
const fail = (message) => { throw new Error(message); };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exists = (file) => fs.existsSync(file);

export function extractFunction(source, name) {
  const match = new RegExp(`^(?:async )?function\\*? ${name}\\(`, 'm').exec(source);
  if (!match) fail(`Reviewed function ${name} was not found.`);
  const end = source.indexOf('\n}\n', match.index);
  if (end < 0) fail(`Reviewed function ${name} is incomplete.`);
  return { start: match.index, end: end + 3, text: source.slice(match.index, end + 3) };
}

function exactlyOnce(source, from, to) {
  if (source.split(from).length !== 2) fail('Reviewed patch context does not match exactly once.');
  return source.replace(from, to);
}

export function patchBundle(source) {
  const dispatcher = extractFunction(source, 'streamOverApi');
  const parameters = /^function streamOverApi\((\w+), (\w+), (\w+)\)/.exec(dispatcher.text);
  if (!parameters) fail('Reviewed dispatch parameters do not match.');
  const [, model, context, options] = parameters;
  let changed = exactlyOnce(dispatcher.text,
    `  return api().stream(${model}, normalizeContext(${context}), ${options});`,
    `  const routed = __agnesModelRouting.prepare(${model}, ${options});\n` +
    `  return api().stream(routed.model, normalizeContext(${context}), routed.options);`);
  source = source.slice(0, dispatcher.start) + changed + source.slice(dispatcher.end);
  const translator = extractFunction(source, 'translateEvent');
  changed = exactlyOnce(translator.text,
    'withResponse(wire, ev.message.responseId, ev.message.responseModel)',
    'withResponse(wire, ev.message.responseId, __agnesModelRouting.responseModel(model, ev.message.responseModel))');
  changed = exactlyOnce(changed,
    'withResponse(wire, ev.error.responseId, ev.error.responseModel)',
    'withResponse(wire, ev.error.responseId, __agnesModelRouting.responseModel(model, ev.error.responseModel))');
  source = source.slice(0, translator.start) + changed + source.slice(translator.end);
  const injected = `import * as __agnesModelRouting from './${RUNTIME}';\n`;
  const index = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;
  return source.slice(0, index) + injected + source.slice(index);
}

function files(directory) {
  const root = path.resolve(directory);
  return { root, state: path.join(root, STATE), switch: path.join(root, SWITCH),
    runtime: path.join(root, RUNTIME), backups: path.join(root, BACKUP_DIR) };
}

function atomicWrite(file, bytes) {
  const temporary = file + `.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function removeBackups(p) {
  if (!exists(p.backups)) return;
  for (const name of Object.keys(ORIGINAL_HASHES)) fs.rmSync(path.join(p.backups, name), { force: true });
  try { fs.rmdirSync(p.backups); }
  catch (error) { if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error; }
}

function loadInstalled(p) {
  const state = JSON.parse(fs.readFileSync(p.state, 'utf8'));
  if (state.version !== 1 || state.ciRun !== '37262837798' || !state.hashes) fail('Invalid install record.');
  for (const name of Object.keys(ORIGINAL_HASHES)) {
    if (!exists(path.join(p.root, name)) || sha(fs.readFileSync(path.join(p.root, name))) !== state.hashes[name])
      fail(`${name} changed after installation; refusing to overwrite it.`);
    if (!exists(path.join(p.backups, name)) || sha(fs.readFileSync(path.join(p.backups, name))) !== ORIGINAL_HASHES[name])
      fail(`Original backup of ${name} is missing or changed.`);
  }
  if (!exists(p.runtime) || sha(fs.readFileSync(p.runtime)) !== state.runtimeHash)
    fail('Installed routing helper changed; refusing to switch automatically.');
  return state;
}

function legacyProfile(options, env) {
  const nonEmpty = (v) => v?.trim() ? v : undefined;
  const explicit = options.home ?? nonEmpty(env.AGH_HOME) ?? nonEmpty(env.AGNES_HOME);
  const home = explicit ?? path.join(nonEmpty(env.HOME) ?? os.homedir(), '.agh');
  const profile = options.profile ?? nonEmpty(env.AGNES_PROFILE) ?? 'local-dev';
  if (!path.isAbsolute(home) || !['local-dev', 'enterprise'].includes(profile)) fail('Invalid home/profile.');
  const dir = path.join(home, 'profiles', profile);
  const marker = path.join(dir, 'gpt61-sol-manual-profile.json');
  if (!exists(marker)) return undefined;
  const record = JSON.parse(fs.readFileSync(marker, 'utf8'));
  const yaml = path.join(dir, 'profile.yaml'), config = path.join(dir, 'configuration.json');
  if (record.version !== 1 || exists(config) || !exists(yaml) || sha(fs.readFileSync(yaml)) !== record.generatedHash)
    fail('The previous manual profile changed; restore/review it before installing this tool.');
  const backupPath = (name) => {
    if (typeof name !== 'string' || path.basename(name) !== name || /[\\/]/.test(name)) fail('Invalid previous backup path.');
    return path.join(dir, name);
  };
  const configBackup = backupPath(record.configBackup);
  const profileBackup = record.profileBackup ? backupPath(record.profileBackup) : null;
  if (sha(fs.readFileSync(configBackup)) !== record.configHash ||
      (profileBackup && sha(fs.readFileSync(profileBackup)) !== record.profileHash)) fail('Previous profile backup changed.');
  return { marker, yaml, config, configBackup, profileBackup };
}

function restoreLegacy(p) {
  if (!p) return false;
  const temp = p.yaml + `.restore-${randomUUID()}`;
  let profileRestored = false, configRestored = false;
  try {
    fs.renameSync(p.yaml, temp);
    if (p.profileBackup) { fs.renameSync(p.profileBackup, p.yaml); profileRestored = true; }
    fs.renameSync(p.configBackup, p.config); configRestored = true;
    fs.rmSync(p.marker);
  } catch (error) {
    if (configRestored) fs.renameSync(p.config, p.configBackup);
    if (profileRestored) fs.renameSync(p.yaml, p.profileBackup);
    if (exists(temp)) fs.renameSync(temp, p.yaml);
    throw error;
  }
  fs.rmSync(temp);
  return true;
}

export function install(options = {}, env = process.env) {
  const p = files(options.dir ?? TOOL_DIR);
  if (exists(p.state)) {
    loadInstalled(p);
    const previous = legacyProfile(options, env);
    const migrated = restoreLegacy(previous);
    atomicWrite(p.switch, JSON.stringify({ version: 1, enabled: options.enabled ?? true }, null, 2) + '\n');
    return { installed: true, enabled: options.enabled ?? true, manualProfileRestored: migrated,
      restartRequired: migrated };
  }
  if (exists(p.backups) || exists(p.switch)) fail('Untracked routing state exists; review it before installing.');
  const runtimeBytes = fs.readFileSync(path.join(TOOL_DIR, RUNTIME));
  if (p.runtime !== path.join(TOOL_DIR, RUNTIME) && exists(p.runtime) && sha(fs.readFileSync(p.runtime)) !== sha(runtimeBytes))
    fail('An unrelated routing helper already exists at the destination.');
  const previous = legacyProfile(options, env);
  const originals = {}, patches = {}, hashes = {};
  for (const [name, expected] of Object.entries(ORIGINAL_HASHES)) {
    const file = path.join(p.root, name);
    if (!fs.lstatSync(file).isFile()) fail(`${name} must be a regular file.`);
    const bytes = fs.readFileSync(file);
    if (sha(bytes) !== expected) fail(`${name} does not match the reviewed Windows CI; no patch was applied.`);
    originals[name] = bytes;
    patches[name] = Buffer.from(patchBundle(bytes.toString('utf8')));
    hashes[name] = sha(patches[name]);
  }
  const touched = [];
  let copiedRuntime = false;
  let migrated = false;
  try {
    fs.mkdirSync(p.backups);
    for (const [name, bytes] of Object.entries(originals)) fs.writeFileSync(path.join(p.backups, name), bytes, { flag: 'wx' });
    if (p.runtime !== path.join(TOOL_DIR, RUNTIME) && !exists(p.runtime)) {
      fs.writeFileSync(p.runtime, runtimeBytes, { flag: 'wx' }); copiedRuntime = true;
    }
    for (const [name, bytes] of Object.entries(patches)) {
      if (sha(fs.readFileSync(path.join(p.root, name))) !== ORIGINAL_HASHES[name]) fail('Sidecar changed during installation.');
      atomicWrite(path.join(p.root, name), bytes); touched.push(name);
    }
    migrated = restoreLegacy(previous);
    atomicWrite(p.switch, JSON.stringify({ version: 1, enabled: options.enabled ?? true }, null, 2) + '\n');
    atomicWrite(p.state, JSON.stringify({ version: 1, ciRun: '37262837798',
      commit: 'c4efd170547a225890664c1c186a7347399b53e0', hashes, runtimeHash: sha(runtimeBytes) }, null, 2) + '\n');
  } catch (error) {
    for (const name of touched) atomicWrite(path.join(p.root, name), originals[name]);
    if (copiedRuntime) fs.rmSync(p.runtime, { force: true });
    fs.rmSync(p.state, { force: true }); fs.rmSync(p.switch, { force: true });
    removeBackups(p);
    if (migrated) fail('Original profile restored, but routing installation failed and sidecars were rolled back.');
    throw error;
  }
  return { installed: true, enabled: options.enabled ?? true, manualProfileRestored: migrated, restartRequired: true };
}

export function status(options = {}) {
  const p = files(options.dir ?? TOOL_DIR);
  if (!exists(p.state)) return { installed: false, enabled: false };
  loadInstalled(p);
  return { installed: true, enabled: readSwitch(p.switch) };
}

export function setEnabled(options, env = process.env) {
  if (options.enabled || status(options).installed) return install(options, env);
  const migrated = restoreLegacy(legacyProfile(options, env));
  return { installed: false, enabled: false, manualProfileRestored: migrated, restartRequired: migrated };
}

export function uninstall(options = {}) {
  const p = files(options.dir ?? TOOL_DIR);
  loadInstalled(p);
  const restored = [];
  const current = {};
  try {
    for (const name of Object.keys(ORIGINAL_HASHES)) {
      const file = path.join(p.root, name);
      current[name] = fs.readFileSync(file);
      atomicWrite(file, fs.readFileSync(path.join(p.backups, name))); restored.push(name);
    }
  } catch (error) {
    for (const name of restored) atomicWrite(path.join(p.root, name), current[name]);
    throw error;
  }
  fs.rmSync(p.state); fs.rmSync(p.switch, { force: true }); removeBackups(p);
  return { installed: false, enabled: false, restartRequired: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = {};
    let action;
    for (let index = 2; index < process.argv.length; index++) {
      const arg = process.argv[index];
      if (['--on', '--off', '--status', '--uninstall'].includes(arg)) {
        if (action) fail('Choose one switch operation.'); action = arg;
      } else if (['--dir', '--home', '--profile'].includes(arg)) {
        const value = process.argv[++index];
        if (!value || value.startsWith('--')) fail(`Missing value for ${arg}.`);
        options[arg.slice(2)] = value;
      } else fail(`Unknown option ${arg}.`);
    }
    if (!action) fail('Use --on, --off, --status or --uninstall.');
    const result = action === '--status' ? status(options) : action === '--uninstall' ? uninstall(options)
      : setEnabled({ ...options, enabled: action === '--on' });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Routing operation failed.'); process.exitCode = 1;
  }
}
