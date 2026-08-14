/**
 * Regression for issue #570: design-system rules must reach a monorepo workspace
 * by inheriting the repo root's DESIGN.md.
 *
 * Run with: node --test tests/detect-cli-design-monorepo.test.mjs
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '../cli/bin/cli.js');

const PAGE_HTML =
  '<!doctype html><html><head><style>.card { font-family: Verdana, sans-serif; }</style></head>' +
  '<body><div class="card">Hi</div></body></html>';

const DESIGN_MD = `---
typography:
  body:
    fontFamily: "Palatino, Georgia, serif"
---
# Project A Design System
`;

const tempRoots = [];

function runDetect(cwd, targets, env = {}) {
  const result = spawnSync(process.execPath, [CLI, 'detect', '--json', ...targets], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  let findings = [];
  try {
    findings = JSON.parse(result.stdout || '[]');
  } catch {
    throw new Error(`Non-JSON CLI output.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  return findings;
}

function fontFindingsFor(findings, file) {
  return findings.filter(
    (f) => f.antipattern === 'design-system-font' && (!file || f.file === file),
  );
}

function mkPnpmMonorepo({ workspaceDesign = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-detect-mono-pnpm-'));
  tempRoots.push(dir);
  fs.writeFileSync(path.join(dir, 'DESIGN.md'), DESIGN_MD);
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
  fs.mkdirSync(path.join(dir, 'apps/web'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps/web/package.json'), '{"name":"web"}');
  const page = path.join(dir, 'apps/web/page.html');
  fs.writeFileSync(page, PAGE_HTML);
  if (workspaceDesign) {
    fs.writeFileSync(path.join(dir, 'apps/web/DESIGN.md'), workspaceDesign);
  }
  return { dir, page, webDir: path.join(dir, 'apps/web') };
}

after(() => {
  for (const dir of tempRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('detect CLI monorepo DESIGN.md inheritance', () => {
  it('pnpm workspace root: workspace page inherits root DESIGN.md', () => {
    const { dir, page } = mkPnpmMonorepo();
    const findings = runDetect(dir, [page]);
    assert.ok(
      fontFindingsFor(findings, page).some((f) => f.ignoreValue === 'verdana'),
      'Verdana must be flagged via inherited root DESIGN.md',
    );
  });

  it('npm/yarn workspaces root: workspace page inherits root DESIGN.md', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-detect-mono-npm-'));
    tempRoots.push(dir);
    fs.writeFileSync(path.join(dir, 'DESIGN.md'), DESIGN_MD);
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"mono","workspaces":["packages/*"]}');
    fs.mkdirSync(path.join(dir, 'packages/ui'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packages/ui/package.json'), '{"name":"ui"}');
    const page = path.join(dir, 'packages/ui/page.html');
    fs.writeFileSync(page, PAGE_HTML);

    const findings = runDetect(dir, [page]);
    assert.ok(
      fontFindingsFor(findings, page).some((f) => f.ignoreValue === 'verdana'),
      'Verdana must be flagged via inherited root DESIGN.md',
    );
  });

  it('turbo marker root: workspace page inherits root DESIGN.md', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-detect-mono-turbo-'));
    tempRoots.push(dir);
    fs.writeFileSync(path.join(dir, 'DESIGN.md'), DESIGN_MD);
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"mono"}');
    fs.writeFileSync(path.join(dir, 'turbo.json'), '{}');
    fs.mkdirSync(path.join(dir, 'apps/web'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'apps/web/package.json'), '{"name":"web"}');
    const page = path.join(dir, 'apps/web/page.html');
    fs.writeFileSync(page, PAGE_HTML);

    const findings = runDetect(dir, [page]);
    assert.ok(
      fontFindingsFor(findings, page).some((f) => f.ignoreValue === 'verdana'),
      'Verdana must be flagged via inherited root DESIGN.md',
    );
  });

  it('pnpm flow list with inline comment and non-standard dirs still detected', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-detect-mono-flow-'));
    tempRoots.push(dir);
    fs.writeFileSync(path.join(dir, 'DESIGN.md'), DESIGN_MD);
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages: ["services/*"] # deploy targets\n');
    fs.mkdirSync(path.join(dir, 'services/api'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'services/api/package.json'), '{"name":"api"}');
    const page = path.join(dir, 'services/api/page.html');
    fs.writeFileSync(page, PAGE_HTML);

    const findings = runDetect(dir, [page]);
    assert.ok(
      fontFindingsFor(findings, page).some((f) => f.ignoreValue === 'verdana'),
      'inline YAML comment must not defeat workspace-glob recognition',
    );
  });

  it('directory target: scan apps/web dir inherits root DESIGN.md', () => {
    const { dir, page, webDir } = mkPnpmMonorepo();
    const findings = runDetect(dir, [webDir]);
    assert.ok(
      fontFindingsFor(findings, page).some((f) => f.ignoreValue === 'verdana'),
      'Verdana must be flagged when scanning the workspace directory',
    );
  });

  it('workspace-owned DESIGN.md wins over monorepo root', () => {
    const workspaceDesign = `---
typography:
  body:
    fontFamily: "Verdana, sans-serif"
---
# Workspace Design System
`;
    const { dir, page } = mkPnpmMonorepo({ workspaceDesign });
    const findings = runDetect(dir, [page]);
    assert.equal(
      fontFindingsFor(findings, page).length,
      0,
      'workspace DESIGN.md allowing Verdana must suppress inherited root rules',
    );
  });

  it('nested separate repo inherits nothing from monorepo root', () => {
    const { dir } = mkPnpmMonorepo();
    fs.mkdirSync(path.join(dir, 'vendor/other/.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'vendor/other/package.json'), '{"name":"other"}');
    const page = path.join(dir, 'vendor/other/page.html');
    fs.writeFileSync(page, PAGE_HTML);

    const findings = runDetect(dir, [page]);
    assert.equal(
      fontFindingsFor(findings, page).length,
      0,
      'nested repo with no workspaces must not inherit monorepo root DESIGN.md',
    );
  });

  it('home directory is never an owning monorepo root', () => {
    // context.mjs's findMonorepoRoot stops at homeDir before its monorepo
    // check; the engine walk must match, or a workspace-declaring $HOME
    // leaks its DESIGN.md into every git-less project beneath it.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-detect-mono-home-'));
    tempRoots.push(home);
    fs.writeFileSync(path.join(home, 'DESIGN.md'), DESIGN_MD);
    fs.writeFileSync(path.join(home, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
    fs.mkdirSync(path.join(home, 'project'), { recursive: true });
    fs.writeFileSync(path.join(home, 'project/package.json'), '{"name":"p"}');
    const page = path.join(home, 'project/page.html');
    fs.writeFileSync(page, PAGE_HTML);

    const findings = runDetect(home, [page], { HOME: home, USERPROFILE: home });
    assert.equal(
      fontFindingsFor(findings, page).length,
      0,
      'a project under a workspace-declaring $HOME must not inherit its DESIGN.md',
    );
  });
});
