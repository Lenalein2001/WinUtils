const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the real TS managers without starting Electron or touching Windows
// startup settings. Each test owns a newly created temporary data directory.
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'winutils-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, 'data');
  fs.mkdirSync(userData);
  const modules = new Map();
  const electron = { app: { getPath: () => userData } };
  function load(relativePath) {
    const filePath = path.resolve(__dirname, '..', relativePath);
    if (modules.has(filePath)) return modules.get(filePath);
    const exports = {};
    modules.set(filePath, exports);
    const code = ts.transpileModule(fs.readFileSync(filePath, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    vm.runInNewContext(code, {
      exports, require: id => {
        if (Object.hasOwn(overrides, id)) return overrides[id];
        if (id === 'electron') return electron;
        if (id.startsWith('.')) return load(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(filePath), `${id}.ts`)));
        return require(id);
      },
      process, console, Buffer, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval,
    }, { filename: filePath });
    return exports;
  }
  return { root, userData, load };
}

async function syncFixture(t, overrides) {
  const fixtureData = fixture(t, overrides);
  const { FileSyncManager } = fixtureData.load('src/main/fileSyncManager.ts');
  const manager = new FileSyncManager();
  t.after(() => manager.destroy());
  const left = path.join(fixtureData.root, 'left');
  const right = path.join(fixtureData.root, 'right');
  return { ...fixtureData, manager, left, right };
}

for (const mode of ['left-to-right-mirror', 'left-to-right-update', 'right-to-left-mirror', 'right-to-left-update', 'two-way']) {
  test(`sync blocks missing authoritative endpoint: ${mode}`, async t => {
    const { manager, left, right } = await syncFixture(t);
    const survivor = mode.startsWith('right-to-left') ? left : right;
    fs.mkdirSync(survivor);
    fs.writeFileSync(path.join(survivor, 'important.txt'), 'preserve');
    const state = await manager.createJob({ leftPath: left, rightPath: right, mode });
    await assert.rejects(manager.analyze(state.jobs[0].id), /unavailable|Both folders must exist/);
    await assert.rejects(manager.apply(state.jobs[0].id), /unavailable|Both folders must exist/);
    assert.equal(fs.readFileSync(path.join(survivor, 'important.txt'), 'utf8'), 'preserve');
  });
}

test('sync distinguishes an existing empty source from a missing source', async t => {
  const { manager, left, right } = await syncFixture(t);
  fs.mkdirSync(left); fs.mkdirSync(right);
  fs.writeFileSync(path.join(right, 'old.txt'), 'old');
  const state = await manager.createJob({ leftPath: left, rightPath: right, mode: 'left-to-right-mirror' });
  assert.equal((await manager.analyze(state.jobs[0].id)).counts.quarantine, 1);
});

test('directional sync can initialize a new destination', async t => {
  const { manager, left, right } = await syncFixture(t);
  fs.mkdirSync(left); fs.writeFileSync(path.join(left, 'new.txt'), 'new');
  const state = await manager.createJob({ leftPath: left, rightPath: right, mode: 'left-to-right-update' });
  const result = await manager.apply(state.jobs[0].id);
  assert.equal(result.status, 'applied');
  assert.equal(fs.readFileSync(path.join(right, 'new.txt'), 'utf8'), 'new');
});

test('empty source can initialize an empty destination', async t => {
  const { manager, left, right } = await syncFixture(t);
  fs.mkdirSync(left);
  const state = await manager.createJob({ leftPath: left, rightPath: right });
  assert.equal((await manager.apply(state.jobs[0].id)).status, 'applied');
  assert.equal(fs.statSync(right).isDirectory(), true);
});

test('canonical overlap through a parent junction is rejected', async t => {
  const { manager, root, left } = await syncFixture(t);
  fs.mkdirSync(left); fs.mkdirSync(path.join(left, 'child'));
  const alias = path.join(root, 'alias');
  fs.symlinkSync(left, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => { if (fs.existsSync(alias)) fs.unlinkSync(alias); });
  const state = await manager.createJob({ leftPath: left, rightPath: path.join(alias, 'child') });
  await assert.rejects(manager.analyze(state.jobs[0].id), /same or nested/);
  fs.unlinkSync(alias);
});

test('sync rejects a file endpoint and a junction endpoint', async t => {
  const { manager, root, left, right } = await syncFixture(t);
  fs.mkdirSync(left); fs.writeFileSync(right, 'file');
  const state = await manager.createJob({ leftPath: left, rightPath: right });
  await assert.rejects(manager.analyze(state.jobs[0].id), /must be a directory/);
  fs.unlinkSync(right); fs.symlinkSync(left, right, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.analyze(state.jobs[0].id), /junction/);
  // Explicitly unlink the link; cleanup must not traverse its target.
  fs.unlinkSync(right);
  assert.equal(fs.statSync(path.join(root, 'left')).isDirectory(), true);
});

test('permission errors are never interpreted as empty sync roots', async t => {
  let blockedPath;
  const { manager, left, right } = await syncFixture(t, { 'node:fs/promises': {
    ...fsp, readdir: async (...args) => {
      if (args[0] === blockedPath) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fsp.readdir(...args);
    },
  } });
  fs.mkdirSync(left); fs.mkdirSync(right); blockedPath = left;
  const state = await manager.createJob({ leftPath: left, rightPath: right, mode: 'left-to-right-mirror' });
  await assert.rejects(manager.analyze(state.jobs[0].id), /denied/);
});

function startupRecord(index) {
  return { kind: 'registry', id: String(index), name: 'Test', command: 'test.exe', executablePath: 'test.exe',
    arguments: '', scope: 'current-user', location: 'HKCU Run', registryHive: 'HKCU',
    registryPath: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', valueName: `Test${index}`,
    regType: 'REG_SZ', disabledAt: new Date().toISOString() };
}

test('startup cache retains every concurrent update, including concurrent initialization', async t => {
  const { load } = fixture(t);
  const { StartupCacheStore } = load('src/main/cacheStore.ts');
  const store = new StartupCacheStore();
  await Promise.all(Array.from({ length: 30 }, (_, index) => store.upsertDisabledEntry(startupRecord(index))));
  assert.equal((await store.read()).disabledEntries.length, 30);
  await Promise.all(Array.from({ length: 15 }, (_, index) => store.removeDisabledEntry(String(index))));
  assert.equal((await store.read()).disabledEntries.length, 15);
});

test('corrupt startup cache is preserved and prevents mutation', async t => {
  const { load, userData } = fixture(t);
  const directory = path.join(userData, 'startup-manager'); fs.mkdirSync(directory);
  const filePath = path.join(directory, 'startup-cache.json'); fs.writeFileSync(filePath, '{broken');
  const { StartupCacheStore } = load('src/main/cacheStore.ts');
  await assert.rejects(new StartupCacheStore().upsertDisabledEntry(startupRecord(1)));
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{broken');
});

test('failed atomic publication retains the previous startup cache and queue remains usable', async t => {
  let fail = false;
  const { load, userData } = fixture(t, { 'node:fs/promises': {
    ...fsp, rename: async (from, to) => {
      if (fail && to.endsWith('startup-cache.json')) throw Object.assign(new Error('injected disk error'), { code: 'EIO' });
      return fsp.rename(from, to);
    },
  } });
  const { StartupCacheStore } = load('src/main/cacheStore.ts'); const store = new StartupCacheStore();
  await store.upsertDisabledEntry(startupRecord(1)); fail = true;
  await assert.rejects(store.upsertDisabledEntry(startupRecord(2)), /injected disk error/);
  assert.equal((await store.read()).disabledEntries.length, 1);
  fail = false; await store.upsertDisabledEntry(startupRecord(3));
  assert.deepEqual(Array.from((await store.read()).disabledEntries, item => item.id), ['1', '3']);
  assert.equal(fs.readdirSync(path.join(userData, 'startup-manager')).some(name => name.endsWith('.tmp')), false);
});

test('startup backup exists before registry deletion and survives deletion failure', async t => {
  let cache;
  const { load } = fixture(t, { 'node:child_process': { execFile: (command, args, callback) => {
    assert.equal(command, 'reg');
    cache.read().then(file => {
      assert.equal(file.disabledEntries.length, 1);
      callback(Object.assign(new Error('injected access denial'), { code: 1 }), '', 'Access is denied.');
    }).catch(callback);
  } } });
  const { StartupCacheStore } = load('src/main/cacheStore.ts'); cache = new StartupCacheStore();
  const { StartupManager } = load('src/main/startupManager.ts');
  await assert.rejects(new StartupManager(cache).disableRegistryEntry(startupRecord(1)));
  assert.equal((await cache.read()).disabledEntries.length, 1);
});

test('failed startup backup prevents the registry mutation', async t => {
  let registryCalls = 0;
  const { load } = fixture(t, {
    'node:child_process': { execFile: () => { registryCalls++; throw new Error('registry must not be called'); } },
  });
  const { StartupCacheStore } = load('src/main/cacheStore.ts'); const cache = new StartupCacheStore();
  cache.upsertDisabledEntry = async () => { throw new Error('backup unavailable'); };
  const { StartupManager } = load('src/main/startupManager.ts');
  await assert.rejects(new StartupManager(cache).disableRegistryEntry(startupRecord(1)), /backup unavailable/);
  assert.equal(registryCalls, 0);
});

test('startup restore failure retains backup and cannot overwrite an existing file', async t => {
  const { load, root } = fixture(t);
  const { StartupCacheStore } = load('src/main/cacheStore.ts'); const cache = new StartupCacheStore();
  const { StartupManager } = load('src/main/startupManager.ts'); const manager = new StartupManager(cache);
  const originalPath = path.join(root, 'startup.lnk'), cachedPath = path.join(root, 'cached.lnk');
  fs.writeFileSync(originalPath, 'new owner'); fs.writeFileSync(cachedPath, 'original');
  const record = { ...startupRecord(1), kind: 'startup-folder', originalPath, cachedPath };
  await cache.upsertDisabledEntry(record);
  await assert.rejects(manager.enableEntry(record.id), /already exists/);
  assert.equal((await cache.read()).disabledEntries.length, 1);
  assert.equal(fs.readFileSync(originalPath, 'utf8'), 'new owner');
  fs.unlinkSync(originalPath);
  manager.listEntries = async () => [];
  await manager.enableEntry(record.id);
  assert.equal((await cache.read()).disabledEntries.length, 0);
  assert.equal(fs.readFileSync(originalPath, 'utf8'), 'original');
});

test('rename Apply/Undo preserves file contents through swaps and case-only changes', async t => {
  const { load, root } = fixture(t); const { RenamerManager } = load('src/main/renamerManager.ts');
  const manager = new RenamerManager(); const directory = path.join(root, 'names'); fs.mkdirSync(directory);
  for (const [name, text] of [['1.txt', 'one'], ['2.txt', 'two']]) fs.writeFileSync(path.join(directory, name), text);
  const items = await manager.loadPaths({ paths: [directory], recursive: false, includeFolders: false });
  const applied = await manager.apply({ items, rules: [
    { id: 'clear', type: 'clear-name', enabled: true },
    { id: 'number', type: 'numbering', enabled: true, start: 2, increment: -1, padding: 0, position: 'prefix', separator: '' },
  ] });
  assert.equal(fs.readFileSync(path.join(directory, '1.txt'), 'utf8'), 'two');
  await manager.undo(applied.transaction.id);
  assert.equal(fs.readFileSync(path.join(directory, '1.txt'), 'utf8'), 'one');
  assert.equal(fs.readFileSync(path.join(directory, '2.txt'), 'utf8'), 'two');
  fs.writeFileSync(path.join(directory, 'UPPER.txt'), 'case');
  const caseItems = await manager.loadPaths({ paths: [path.join(directory, 'UPPER.txt')], recursive: false, includeFolders: false });
  const caseApply = await manager.apply({ items: caseItems, rules: [{ id: 'case', type: 'case', enabled: true, mode: 'lower' }] });
  await manager.undo(caseApply.transaction.id);
  assert.equal(fs.readdirSync(directory).includes('UPPER.txt'), true);
});

test('rename Undo refuses an externally replaced file', async t => {
  const { load, root } = fixture(t); const { RenamerManager } = load('src/main/renamerManager.ts');
  const manager = new RenamerManager(); const source = path.join(root, 'a.txt'); fs.writeFileSync(source, 'original');
  const items = await manager.loadPaths({ paths: [source], recursive: false, includeFolders: false });
  const result = await manager.apply({ items, rules: [{ id: 'prefix', type: 'prefix-suffix', enabled: true, prefix: 'new-', suffix: '' }] });
  fs.renameSync(path.join(root, 'new-a.txt'), path.join(root, 'elsewhere.txt'));
  fs.writeFileSync(path.join(root, 'new-a.txt'), 'replacement');
  await assert.rejects(manager.undo(result.transaction.id), /replaced/);
  assert.equal(fs.readFileSync(path.join(root, 'new-a.txt'), 'utf8'), 'replacement');
});

for (const moveCount of [0, 1, 2, 3, 4]) {
  test(`rename journal recovers interrupted swap after ${moveCount} moves`, async t => {
    const { load, root, userData } = fixture(t);
    const from = [path.join(root, 'a.txt'), path.join(root, 'b.txt')];
    fs.writeFileSync(from[0], 'a'); fs.writeFileSync(from[1], 'b');
    const operations = from.map((filePath, index) => {
      const info = fs.lstatSync(filePath, { bigint: true });
      return { fromPath: filePath, toPath: from[1 - index], originalName: path.basename(filePath),
        targetName: path.basename(from[1 - index]), kind: 'file',
        identity: { device: String(info.dev), inode: String(info.ino) },
        tempPath: path.join(root, `.winutils-renaming-${index}.tmp`) };
    });
    const journal = { version: 1, phase: 'moving', transaction: { id: 'test', createdAt: new Date().toISOString(), operations }, undo: false, operations };
    fs.writeFileSync(path.join(userData, 'rename-journal.json'), JSON.stringify(journal));
    for (let index = 0; index < Math.min(moveCount, 2); index++) fs.renameSync(operations[index].fromPath, operations[index].tempPath);
    for (let index = 0; index < Math.max(moveCount - 2, 0); index++) fs.renameSync(operations[index].tempPath, operations[index].toPath);
    const { RenamerManager } = load('src/main/renamerManager.ts'); await new RenamerManager().init();
    assert.equal(fs.readFileSync(from[0], 'utf8'), 'a'); assert.equal(fs.readFileSync(from[1], 'utf8'), 'b');
    assert.equal(fs.existsSync(path.join(userData, 'rename-journal.json')), false);
  });
}

test('committed rename journal completes history after a failed history write', async t => {
  let failHistory = true;
  const { load, root, userData } = fixture(t, { 'node:fs/promises': {
    ...fsp, rename: async (from, to) => {
      if (failHistory && to.endsWith('renamer-transactions.json')) throw new Error('injected history write failure');
      return fsp.rename(from, to);
    },
  } });
  const { RenamerManager } = load('src/main/renamerManager.ts'); const manager = new RenamerManager();
  const source = path.join(root, 'a.txt'); fs.writeFileSync(source, 'a');
  const items = await manager.loadPaths({ paths: [source], recursive: false, includeFolders: false });
  await assert.rejects(manager.apply({ items, rules: [{ id: 'prefix', type: 'prefix-suffix', enabled: true, prefix: 'new-', suffix: '' }] }), /history write failure/);
  assert.equal(fs.existsSync(source), false); assert.equal(fs.existsSync(path.join(root, 'new-a.txt')), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'rename-journal.json'), 'utf8')).phase, 'committed');
  failHistory = false;
  const restarted = new RenamerManager(); await restarted.init();
  const transactions = await restarted.listTransactions(); assert.equal(transactions.length, 1);
  await restarted.undo(transactions[0].id); assert.equal(fs.readFileSync(source, 'utf8'), 'a');
});

test('partial swap install failure rolls back every file', async t => {
  let fileMoves = 0;
  const { load, root, userData } = fixture(t, { 'node:fs/promises': {
    ...fsp, rename: async (from, to) => {
      if (path.dirname(from) === root && ++fileMoves === 4) throw new Error('injected final rename failure');
      return fsp.rename(from, to);
    },
  } });
  const { RenamerManager } = load('src/main/renamerManager.ts'); const manager = new RenamerManager();
  fs.writeFileSync(path.join(root, '1.txt'), 'one'); fs.writeFileSync(path.join(root, '2.txt'), 'two');
  const items = await manager.loadPaths({ paths: [path.join(root, '1.txt'), path.join(root, '2.txt')], recursive: false, includeFolders: false });
  await assert.rejects(manager.apply({ items, rules: [
    { id: 'clear', type: 'clear-name', enabled: true },
    { id: 'number', type: 'numbering', enabled: true, start: 2, increment: -1, padding: 0, position: 'prefix', separator: '' },
  ] }), /all transaction files were restored/);
  assert.equal(fs.readFileSync(path.join(root, '1.txt'), 'utf8'), 'one');
  assert.equal(fs.readFileSync(path.join(root, '2.txt'), 'utf8'), 'two');
  assert.equal(fs.existsSync(path.join(userData, 'rename-journal.json')), false);
  assert.equal((await manager.listTransactions()).length, 0);
});

test('failed rollback reports recovery paths and retains a recoverable journal', async t => {
  let fail = true; let moves = 0;
  const { load, root, userData } = fixture(t, { 'node:fs/promises': {
    ...fsp, rename: async (from, to) => {
      if (path.dirname(from) === root && fail && ++moves >= 2) throw new Error('injected device unavailable');
      return fsp.rename(from, to);
    },
  } });
  const { RenamerManager } = load('src/main/renamerManager.ts'); const manager = new RenamerManager();
  const source = path.join(root, 'a.txt'); fs.writeFileSync(source, 'a');
  const items = await manager.loadPaths({ paths: [source], recursive: false, includeFolders: false });
  await assert.rejects(manager.apply({ items, rules: [{ id: 'prefix', type: 'prefix-suffix', enabled: true, prefix: 'new-', suffix: '' }] }), /Recovery is incomplete; journal preserved/);
  assert.equal(fs.existsSync(path.join(userData, 'rename-journal.json')), true);
  fail = false; await new RenamerManager().init();
  assert.equal(fs.readFileSync(source, 'utf8'), 'a');
  assert.equal(fs.existsSync(path.join(userData, 'rename-journal.json')), false);
});

test('recovery preserves an unrelated file recreated at the original path', async t => {
  const { load, root, userData } = fixture(t);
  const source = path.join(root, 'a.txt'), target = path.join(root, 'b.txt'); fs.writeFileSync(source, 'owned');
  const info = fs.lstatSync(source, { bigint: true });
  const operation = { fromPath: source, toPath: target, originalName: 'a.txt', targetName: 'b.txt', kind: 'file',
    identity: { device: String(info.dev), inode: String(info.ino) }, tempPath: path.join(root, '.winutils-renaming-0.tmp') };
  fs.writeFileSync(path.join(userData, 'rename-journal.json'), JSON.stringify({ version: 1, phase: 'moving', undo: false,
    transaction: { id: 'collision', createdAt: new Date().toISOString(), operations: [operation] }, operations: [operation] }));
  fs.renameSync(source, target); fs.writeFileSync(source, 'unrelated');
  const { RenamerManager } = load('src/main/renamerManager.ts');
  await assert.rejects(new RenamerManager().init(), /target already exists/);
  assert.equal(fs.readFileSync(source, 'utf8'), 'unrelated');
  assert.equal(fs.existsSync(path.join(userData, 'rename-journal.json')), true);
  fs.renameSync(source, path.join(root, 'unrelated.txt'));
  await new RenamerManager().init(); assert.equal(fs.readFileSync(source, 'utf8'), 'owned');
});

test('rename journal publication failure leaves every source untouched', async t => {
  const { load, root } = fixture(t, { 'node:fs/promises': {
    ...fsp, rename: async (from, to) => {
      if (to.endsWith('rename-journal.json')) throw new Error('journal write failed');
      return fsp.rename(from, to);
    },
  } });
  const { RenamerManager } = load('src/main/renamerManager.ts'); const manager = new RenamerManager();
  const source = path.join(root, 'a.txt'); fs.writeFileSync(source, 'a');
  const items = await manager.loadPaths({ paths: [source], recursive: false, includeFolders: false });
  await assert.rejects(manager.apply({ items, rules: [{ id: 'prefix', type: 'prefix-suffix', enabled: true, prefix: 'new-', suffix: '' }] }), /journal write failed/);
  assert.equal(fs.readFileSync(source, 'utf8'), 'a');
  assert.equal(fs.existsSync(path.join(root, 'new-a.txt')), false);
});

test('corrupt rename history is preserved and no batch is applied', async t => {
  const { load, root, userData } = fixture(t);
  const filePath = path.join(userData, 'renamer-transactions.json'); fs.writeFileSync(filePath, '{broken');
  const { RenamerManager } = load('src/main/renamerManager.ts'); const manager = new RenamerManager();
  await assert.rejects(manager.listTransactions());
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{broken');
  const source = path.join(root, 'a.txt'); fs.writeFileSync(source, 'a');
  const items = await manager.loadPaths({ paths: [source], recursive: false, includeFolders: false });
  // Reading history must succeed before any journaled mutation is allowed.
  await assert.rejects(manager.apply({ items, rules: [{ id: 'prefix', type: 'prefix-suffix', enabled: true, prefix: 'new-', suffix: '' }] }));
  assert.equal(fs.readFileSync(source, 'utf8'), 'a');
});
