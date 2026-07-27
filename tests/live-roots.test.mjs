import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  discoverAppCandidates,
  findGitRoot,
  resolveLiveRoots,
  resolveRoots,
  writeRootsManifest,
} from '../skill/scripts/live/roots.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOTS_MODULE = join(__dirname, '..', 'skill', 'scripts', 'live', 'roots.mjs');

function write(root, rel, content = '') {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe('live roots resolution', () => {
  let tmp;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'impeccable-roots-')));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function setupPlainNestedApp() {
    // The agent-reviews shape: a git repo whose root is a CLI package (no dev
    // config, no workspaces) with the served app nested in website/.
    mkdirSync(join(tmp, '.git'), { recursive: true });
    write(tmp, 'package.json', JSON.stringify({ name: 'cli-package' }));
    write(tmp, 'PRODUCT.md', '# product');
    write(tmp, 'DESIGN.md', '# design');
    write(tmp, 'website/package.json', JSON.stringify({ name: 'website' }));
    write(tmp, 'website/svelte.config.js', 'export default {};');
    write(tmp, 'website/vite.config.js', 'export default {};');
    write(tmp, 'website/src/routes/+page.svelte', '<h1>hi</h1>');
  }

  it('roots a targeted file at the nested app, context at the git root', () => {
    setupPlainNestedApp();
    const { manifest } = resolveRoots({
      cwd: tmp,
      targetPath: join(tmp, 'website/src/routes/+page.svelte'),
    });
    assert.equal(manifest.appRoot, join(tmp, 'website'));
    assert.equal(manifest.repoRoot, tmp);
    assert.equal(manifest.contextRoot, tmp);
    assert.equal(manifest.productPath, join(tmp, 'PRODUCT.md'));
    assert.equal(manifest.designPath, join(tmp, 'DESIGN.md'));
    assert.equal(manifest.sessionRoot, join(tmp, 'website', '.impeccable', 'live'));
  });

  it('auto-picks a single nested app when booted from the repo root without a target', () => {
    setupPlainNestedApp();
    const { manifest, selection } = resolveRoots({ cwd: tmp });
    assert.equal(selection, undefined);
    assert.equal(manifest.appRoot, join(tmp, 'website'));
    assert.match(manifest.resolvedFrom, /^candidate:/);
  });

  it('asks for a selection when several nested apps exist', () => {
    setupPlainNestedApp();
    write(tmp, 'admin/package.json', JSON.stringify({ name: 'admin' }));
    write(tmp, 'admin/vite.config.ts', 'export default {};');
    const { manifest, selection } = resolveRoots({ cwd: tmp });
    assert.equal(manifest, undefined);
    assert.equal(selection.candidates.length, 2);
    assert.deepEqual(selection.candidates.map((c) => c.name).sort(), ['admin', 'website']);
  });

  it('resolves context files independently across levels', () => {
    setupPlainNestedApp();
    rmSync(join(tmp, 'DESIGN.md'));
    write(tmp, 'website/DESIGN.md', '# child design');
    const { manifest } = resolveRoots({
      cwd: tmp,
      targetPath: join(tmp, 'website/src/routes/+page.svelte'),
    });
    assert.equal(manifest.designPath, join(tmp, 'website', 'DESIGN.md'));
    assert.equal(manifest.productPath, join(tmp, 'PRODUCT.md'));
  });

  it('treats a live-configured directory as an app root without a dev config', () => {
    mkdirSync(join(tmp, '.git'), { recursive: true });
    write(tmp, 'site/.impeccable/live/config.json', '{"files":["index.html"]}');
    write(tmp, 'site/index.html', '<html></html>');
    const { manifest } = resolveRoots({ cwd: tmp, targetPath: join(tmp, 'site/index.html') });
    assert.equal(manifest.appRoot, join(tmp, 'site'));
  });

  it('stays at cwd when no app markers exist anywhere', () => {
    write(tmp, 'notes.txt', 'nothing here');
    const { manifest } = resolveRoots({ cwd: tmp });
    assert.equal(manifest.appRoot, tmp);
    assert.equal(manifest.repoRoot, tmp);
    assert.equal(manifest.resolvedFrom, 'fallback');
  });

  it('does not ascend above cwd without a git boundary', () => {
    write(tmp, 'vite.config.js', 'export default {};');
    const nested = join(tmp, 'deep', 'inner');
    mkdirSync(nested, { recursive: true });
    const { manifest } = resolveRoots({ cwd: nested });
    // tmp has a dev config but there is no git root, so the walk must not
    // climb out of the starting directory.
    assert.equal(manifest.appRoot, nested);
  });

  it('persists a manifest and finds it again from anywhere in the repo', () => {
    setupPlainNestedApp();
    const { manifest } = resolveRoots({
      cwd: tmp,
      targetPath: join(tmp, 'website/src/routes/+page.svelte'),
    });
    writeRootsManifest(manifest);

    // From deep inside the app: found by upward walk.
    const fromApp = resolveLiveRoots(join(tmp, 'website/src/routes'));
    assert.equal(fromApp.source, 'persisted');
    assert.equal(fromApp.manifest.appRoot, join(tmp, 'website'));

    // From the repo root: found via the pointer.
    const fromRepo = resolveLiveRoots(tmp);
    assert.equal(fromRepo.source, 'pointer');
    assert.equal(fromRepo.manifest.appRoot, join(tmp, 'website'));
  });

  it('ignores a stale manifest that claims a different appRoot', () => {
    setupPlainNestedApp();
    write(tmp, 'website/.impeccable/live/roots.json', JSON.stringify({
      version: 1,
      appRoot: join(tmp, 'elsewhere'),
    }));
    const res = resolveLiveRoots(join(tmp, 'website'));
    assert.equal(res.source, 'fresh');
    assert.equal(res.manifest.appRoot, join(tmp, 'website'));
  });

  it('finds the git root through intermediate directories', () => {
    mkdirSync(join(tmp, '.git'), { recursive: true });
    const deep = join(tmp, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    assert.equal(findGitRoot(deep), tmp);
  });

  it('discovers app candidates below common monorepo layouts', () => {
    mkdirSync(join(tmp, '.git'), { recursive: true });
    write(tmp, 'apps/web/next.config.js', 'module.exports = {};');
    write(tmp, 'apps/api/package.json', '{"name":"api"}');
    write(tmp, 'packages/ui/package.json', '{"name":"ui"}');
    const candidates = discoverAppCandidates(tmp);
    assert.deepEqual(candidates, [join(tmp, 'apps', 'web')]);
  });

  it('enterLiveRoot moves a process onto the persisted appRoot', () => {
    setupPlainNestedApp();
    const { manifest } = resolveRoots({
      cwd: tmp,
      targetPath: join(tmp, 'website/src/routes/+page.svelte'),
    });
    writeRootsManifest(manifest);
    const res = spawnSync(process.execPath, [
      '-e',
      `import(${JSON.stringify(ROOTS_MODULE)}).then((m) => { m.enterLiveRoot(); console.log(process.cwd()); });`,
    ], { cwd: tmp, encoding: 'utf-8' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(realpathSync(res.stdout.trim()), join(tmp, 'website'));
  });
});

describe('review regressions: walk bounds', () => {
  it('does not climb past a target outside the cwd git repo (m5)', () => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), 'impeccable-roots-outer-')));
    try {
      mkdirSync(join(outer, 'repo', '.git'), { recursive: true });
      writeFileSync(join(outer, 'vite.config.js'), 'export default {};');
      const loose = join(outer, 'loose', 'inner', 'sub');
      mkdirSync(loose, { recursive: true });
      const { manifest } = resolveRoots({ cwd: join(outer, 'repo'), targetPath: loose });
      // The dev config at `outer` sits above the target's own tree with no
      // git boundary; the walk must not adopt it.
      assert.notEqual(manifest.appRoot, outer);
      assert.equal(manifest.appRoot, loose);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});
