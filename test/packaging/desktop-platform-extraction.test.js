import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { extractionScript } from '../../scripts/desktop-extract.mjs';
import { bootstrap, runtimeFingerprint } from '../../scripts/desktop-runtime.mjs';
import { prunePython } from '../../scripts/prepare-desktop.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const venv = path.join(root, '.scratch/pipeline/venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3');
const pythonCommand = existsSync(venv) ? venv : process.platform === 'win32' ? 'python' : 'python3';
const resolvedPython = spawnSync(pythonCommand, ['-I', '-B', '-c', 'import sys; print(sys.executable)'], { cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true });
assert.equal(resolvedPython.status, 0, resolvedPython.stderr || resolvedPython.error?.message);
const python = resolvedPython.stdout.trim();
assert.ok(path.isAbsolute(python), 'Python must resolve to an absolute executable path before PATH is cleared');
const fixtureScript = String.raw`
import io, json, sys, tarfile, zipfile
file, kind, spec = sys.argv[1:]
entries = json.loads(spec)
if kind == 'zip':
    with zipfile.ZipFile(file,'w') as z:
        for e in entries:
            i = zipfile.ZipInfo(e['name'])
            i.filename = e['name']
            i.external_attr = e.get('mode',0o100644) << 16
            z.writestr(i,e.get('content','value'))
else:
    with tarfile.open(file,'w:gz') as t:
        for e in entries:
            i=tarfile.TarInfo(e['name']); i.mode=e.get('mode',0o755)
            i.type={'file':tarfile.REGTYPE,'symlink':tarfile.SYMTYPE,'hardlink':tarfile.LNKTYPE,'dir':tarfile.DIRTYPE,'device':tarfile.CHRTYPE,'fifo':tarfile.FIFOTYPE}[e.get('kind','file')]
            if i.type == tarfile.REGTYPE:
                data=e.get('content','value').encode(); i.size=len(data); t.addfile(i,io.BytesIO(data))
            else:
                i.linkname=e.get('link',''); t.addfile(i)
`;
const run = (code, args, options = {}) => spawnSync(python, ['-I', '-B', '-c', code, ...args], { cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true, ...options });
async function workspace(t) {
  const base = path.join(root, '.scratch/desktop-port/unit'); await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'extract-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
async function fixture(dir, kind, entries) {
  const archive = path.join(dir, 'fixture.' + (kind === 'zip' ? 'zip' : 'tar.gz'));
  const made = run(fixtureScript, [archive, kind, JSON.stringify(entries)]);
  assert.equal(made.status, 0, made.stderr || made.error?.message);
  return archive;
}

test('safe extraction handles ZIP and standalone TAR, preserving runtime bin and executable modes', async (t) => {
  const dir = await workspace(t);
  for (const kind of ['zip', 'tar.gz']) {
    const archive = await fixture(dir, kind, [{ name: kind === 'zip' ? 'python.exe' : 'python/bin/python3', mode: 0o100755 },
      ...(kind === 'zip' ? [] : [{ name: 'python/share/terminfo/a/A' }, { name: 'python/share/terminfo/a/a' }])]);
    const destination = path.join(dir, 'out-' + kind);
    const extracted = run(extractionScript, [archive, destination, kind]);
    assert.equal(extracted.status, 0, extracted.stderr);
    const file = path.join(destination, kind === 'zip' ? 'python.exe' : 'bin/python3');
    assert.equal(await fs.readFile(file, 'utf8'), 'value');
    if (kind !== 'zip') assert.equal(existsSync(path.join(destination, 'share/terminfo')), false);
    await fs.mkdir(path.join(destination, 'lib/test'), { recursive: true });
    await fs.writeFile(path.join(destination, 'lib/test/unwanted.py'), 'test');
    await prunePython(destination);
    assert.equal(existsSync(file), true, 'runtime bin must not be removed by the package-source filter');
    assert.equal(existsSync(path.join(destination, 'lib/test')), false);
    if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o755);
    const repeat = run(extractionScript, [archive, destination, kind]);
    assert.notEqual(repeat.status, 0); assert.match(repeat.stderr, /must not exist/);
  }
});

test('extraction refuses traversal, escaping links, links as ancestors, duplicates and devices before writing', async (t) => {
  const dir = await workspace(t);
  const cases = [
    ['zip', [{ name: '../escape' }]], ['zip', [{ name: 'C:/escape' }]], ['zip', [{ name: '/escape' }]],
    ['zip', [{ name: 'dir\\escape' }]], ['zip', [{ name: 'CON' }]], ['zip', [{ name: 'link', mode: 0o120777 }]],
    ['tar.gz', [{ name: 'python/../escape' }]], ['tar.gz', [{ name: 'python/dev', kind: 'device' }]],
    ['tar.gz', [{ name: 'python/dev', kind: 'fifo' }]], ['tar.gz', [{ name: 'outside/file' }]],
    ['tar.gz', [{ name: 'python/link', kind: 'symlink', link: '../../escape' }]],
    ['tar.gz', [{ name: 'python/link', kind: 'symlink', link: '/tmp/escape' }]],
    ['tar.gz', [{ name: 'python/link', kind: 'hardlink', link: '../escape' }]],
    ['tar.gz', [{ name: 'python/link', kind: 'symlink', link: 'target' }, { name: 'python/target', kind: 'dir' }, { name: 'python/link/write' }]],
    ['tar.gz', [{ name: 'python/a' }, { name: 'python/a' }]]
  ];
  for (const [index, [kind, entries]] of cases.entries()) {
    const archive = await fixture(dir, kind, entries), destination = path.join(dir, 'bad-' + index);
    const result = run(extractionScript, [archive, destination, kind]);
    assert.notEqual(result.status, 0, JSON.stringify(entries));
    assert.equal(existsSync(destination), false, result.stderr);
  }
  assert.equal(existsSync(path.join(dir, 'escape')), false);
  const badOptional = await fixture(dir, 'tar.gz', [{ name: 'python/share/terminfo/bad', kind: 'symlink', link: '../../../../escape' }]);
  assert.notEqual(run(extractionScript, [badOptional, path.join(dir, 'bad-optional'), 'tar.gz']).status, 0);
});

test('internal hardlinks work; POSIX symlinks stay internal and participate in fingerprints', async (t) => {
  const dir = await workspace(t);
  const entries = [{ name: 'python/bin/python3.14' }, { name: 'python/bin/python3', kind: process.platform === 'win32' ? 'hardlink' : 'symlink', link: process.platform === 'win32' ? 'python/bin/python3.14' : 'python3.14' }];
  const archive = await fixture(dir, 'tar.gz', entries), destination = path.join(dir, 'linked');
  const result = run(extractionScript, [archive, destination, 'tar.gz']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(path.join(destination, 'bin/python3'), 'utf8'), 'value');
  await runtimeFingerprint(destination);
  if (process.platform !== 'win32') {
    await fs.unlink(path.join(destination, 'bin/python3'));
    await fs.symlink(dir, path.join(destination, 'bin/python3'));
    await assert.rejects(runtimeFingerprint(destination), /Escaping runtime link/);
  }
});

test('bootstrap starts only private package with isolated Python, not CWD/PYTHONPATH/user site', async (t) => {
  const dir = await workspace(t), runtime = path.join(dir, 'runtime'), hostile = path.join(dir, 'hostile');
  await fs.mkdir(path.join(runtime, 'site-packages/scranton_pipeline'), { recursive: true });
  await fs.mkdir(path.join(hostile, 'scranton_pipeline'), { recursive: true });
  await fs.writeFile(path.join(runtime, 'bootstrap.py'), bootstrap);
  await fs.writeFile(path.join(runtime, 'site-packages/scranton_pipeline/__init__.py'), '');
  await fs.writeFile(path.join(hostile, 'scranton_pipeline/__init__.py'), '');
  await fs.writeFile(path.join(runtime, 'site-packages/scranton_pipeline/__main__.py'), 'import sys, json\nprint(json.dumps({"private":True,"isolated":sys.flags.isolated,"path":sys.path}))\n');
  await fs.writeFile(path.join(hostile, 'scranton_pipeline/__main__.py'), 'raise RuntimeError("HOST INJECTION")\n');
  const env = { SystemRoot: process.env.SystemRoot, PATH: '', PYTHONPATH: hostile, PYTHONUSERBASE: hostile, HOME: hostile, USERPROFILE: hostile };
  const result = spawnSync(python, ['-I', '-B', path.join(runtime, 'bootstrap.py')], { cwd: hostile, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const observed = JSON.parse(result.stdout); assert.equal(observed.private, true); assert.equal(observed.isolated, 1);
  assert.ok(!observed.path.includes(hostile));
  await fs.rm(path.join(runtime, 'site-packages/scranton_pipeline'), { recursive: true });
  const negative = spawnSync(python, ['-I', '-B', path.join(runtime, 'bootstrap.py')], { cwd: hostile, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.notEqual(negative.status, 0); assert.doesNotMatch(negative.stderr, /HOST INJECTION/);
});

test('directory symlinks fail closed instead of silently losing Tauri resource contents', async (t) => {
  const dir = await workspace(t);
  const archive = await fixture(dir, 'tar.gz', [{ name: 'python/real', kind: 'dir' },
    { name: 'python/real/data', content: 'required data' }, { name: 'python/alias', kind: 'symlink', link: 'real' }]);
  const destination = path.join(dir, 'directory-link');
  const result = run(extractionScript, [archive, destination, 'tar.gz']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Directory symlink cannot be packaged safely/);
  assert.equal(existsSync(destination), false);
  const runtime = path.join(dir, 'runtime');
  await fs.mkdir(path.join(runtime, 'real'), { recursive: true });
  await fs.writeFile(path.join(runtime, 'real/data'), 'required data');
  await fs.symlink(path.join(runtime, 'real'), path.join(runtime, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runtimeFingerprint(runtime), /Directory runtime link cannot be packaged safely/);
});
