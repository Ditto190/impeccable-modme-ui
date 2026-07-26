#!/usr/bin/env node
/**
 * Context-signals gatherer for the bare Impeccable invocation
 * (no-argument) path. Collects cheap, deterministic signals about the current
 * project and emits them as JSON.
 *
 * It does NOT score or rank. The agent reasons over the raw signals using its
 * knowledge of the command catalog (see SKILL.md routing rule 1). Deliberately
 * light: no LLM calls, no detector run (`npx impeccable detect` is heavier and
 * opt-in), no file writes. Every probe is best-effort and never throws; the
 * output is always valid JSON.
 *
 * Signals:
 *   - setup:     PRODUCT.md / DESIGN.md presence and whether code exists
 *   - critique:  the latest cached critique score (.impeccable/critique)
 *   - git:       branch + files changed vs the default branch (a scope hint)
 *   - devServer: whether a local dev server answers on a common port (gates live)
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadContext, extractPlatform } from './context.mjs';
import { getCritiqueDir } from './lib/impeccable-paths.mjs';

/** Is there code here at all, or just context files / an empty repo? */
function hasCode(cwd) {
  if (fs.existsSync(path.join(cwd, 'package.json'))) return true;
  for (const d of ['src', 'app', 'pages', 'site', 'public', 'components', 'lib']) {
    if (fs.existsSync(path.join(cwd, d))) return true;
  }
  return false;
}

/**
 * The most recent critique snapshot across all targets. Filenames are
 * timestamp-prefixed (`<iso>__<slug>.md`), so a lexical sort is chronological.
 * Parses the small frontmatter for score + P0/P1 counts.
 */
function latestCritique(cwd) {
  try {
    const dir = getCritiqueDir(cwd);
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    if (!files.length) return null;
    const newest = files[files.length - 1];
    const text = fs.readFileSync(path.join(dir, newest), 'utf-8');
    const front = text.split('---')[1] || '';
    const get = (k) => {
      const m = front.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'));
      return m ? m[1].trim() : null;
    };
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      slug: get('slug'),
      score: num(get('score')),
      p0: num(get('p0')),
      p1: num(get('p1')),
      timestamp: get('timestamp'),
      file: path.relative(cwd, path.join(dir, newest)),
    };
  } catch {
    return null;
  }
}

/** Branch + a scope hint: files changed vs the default branch, else working tree. */
function gitSignals(cwd) {
  const run = (args, { trim = true } = {}) => {
    try {
      const out = execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return trim ? out.trim() : out;
    } catch {
      return null;
    }
  };
  if (run(['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return { isRepo: false, branch: null, base: null, changedFiles: [], changedCount: 0 };
  }
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  // The merge target is detected, not assumed. A hardcoded main/master list
  // diffed develop-based repos against the wrong base, so git.changedFiles
  // carried the whole develop/main divergence into scan.targets (issue
  // #302). Signals, most specific first: the branch's configured upstream
  // (@{u}; a branch pushed with -u tracks itself and is skipped by the
  // self-check), then the remote's default-branch symref (origin/HEAD),
  // then the conventional integration names. The conventional fallbacks
  // are withheld when the current branch IS one of them: sitting on main
  // in a repo that also has develop must not diff the two integration
  // branches against each other.
  // Candidates carry a display name (what git.base reports) and the revs to
  // try, in order. A remote ref like `upstream/release` (fork workflows) or
  // an origin/HEAD target with no local checkout is a perfectly good diff
  // base, so revs are not limited to local branch names.
  const splitRemoteRef = (ref) => {
    const i = ref ? ref.indexOf('/') : -1;
    return i > 0 ? { name: ref.slice(i + 1), rev: ref } : null;
  };
  // A slashless @{u} is a LOCAL upstream (branch.<x>.remote = "."); it names
  // a merge target just as validly as a remote-tracking ref does.
  const asUpstream = (ref) => splitRemoteRef(ref) || (ref ? { name: ref, rev: ref } : null);
  const conventional = ['develop', 'main', 'master'];
  // On an integration branch itself the scope hint is the working tree. No
  // signal may override that: an origin/HEAD or upstream naming a DIFFERENT
  // integration branch (sitting on develop while the remote default is
  // main) would produce exactly the integration-vs-integration divergence
  // this detection exists to prevent. "Integration branch" means a
  // conventional name OR the remote's default branch, so a non-standard
  // default like trunk is guarded the same way.
  const remoteHead = splitRemoteRef(run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']));
  const onIntegrationBranch = conventional.includes(branch) || branch === remoteHead?.name;
  let base = null;
  let baseRev = null;
  if (!onIntegrationBranch) {
    const upstream = asUpstream(run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']));
    const candidates = [];
    const seen = new Set();
    const addCandidate = (name, revs) => {
      if (!name || name === branch || seen.has(name)) return;
      seen.add(name);
      candidates.push({ name, revs });
    };
    // The upstream tracks the actual merge target, so its own rev wins over
    // a possibly stale local branch of the same name.
    if (upstream) addCandidate(upstream.name, [upstream.rev]);
    // A develop branch marks a git-flow repo where features merge to develop
    // even when the platform default (origin/HEAD) was never flipped off
    // main; an existing develop therefore outranks the remote default. This
    // is #302's own repro shape, and repos without develop are unaffected.
    addCandidate('develop', ['develop', 'origin/develop']);
    if (remoteHead) addCandidate(remoteHead.name, [remoteHead.name, remoteHead.rev]);
    for (const name of ['main', 'master']) addCandidate(name, [name, `origin/${name}`]);
    for (const c of candidates) {
      const rev = c.revs.find((r) => run(['rev-parse', '--verify', '--quiet', r]) !== null);
      if (rev) {
        base = c.name;
        baseRev = rev;
        break;
      }
    }
  }
  const diffBase = base && branch && branch !== base ? base : null;
  const fromDiff = diffBase ? run(['diff', '--name-only', `${baseRev}...HEAD`]) : null;
  // porcelain lines are `XY PATH`: a 2-char status + a space, then the path.
  // Don't trim the combined output — an unstaged-modified line starts with a
  // leading space (` M path`), and a global trim would eat the first line's
  // status column and shift the slice. Renames render as `old -> new`.
  const fromStatus = run(['-c', 'core.quotepath=false', 'status', '--porcelain'], { trim: false });
  let changed = [];
  if (fromDiff) {
    changed = fromDiff.split('\n').filter(Boolean);
  } else if (fromStatus) {
    changed = fromStatus.split(/\r?\n/).filter(Boolean).map((l) => {
      const p = l.slice(3);
      const arrow = p.indexOf(' -> ');
      return arrow === -1 ? p : p.slice(arrow + 4);
    });
  }
  return {
    isRepo: true,
    branch,
    base: diffBase,
    changedFiles: changed.slice(0, 50),
    changedCount: changed.length,
  };
}

const COMMON_DEV_PORTS = [4321, 3000, 5173, 5174, 8080, 8000, 4200];

function probePort(port, timeout = 250) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, '127.0.0.1');
  });
}

async function devServerSignals() {
  const open = [];
  await Promise.all(
    COMMON_DEV_PORTS.map(async (p) => {
      if (await probePort(p)) open.push(p);
    }),
  );
  open.sort((a, b) => a - b);
  return { running: open.length > 0, ports: open };
}

// Extensions the detector scans (mirrors the engine's walkDir set + HTML).
const SCANNABLE_EXT = new Set([
  '.html', '.htm', '.css', '.scss',
  '.jsx', '.tsx', '.js', '.ts', '.vue', '.svelte', '.astro',
]);
// Where UI source typically lives. The detector walks these and skips
// node_modules / dist / build and all hidden dirs automatically.
const SOURCE_DIRS = ['src', 'app', 'components', 'pages', 'public'];

// A changed file under a hidden or dependency/build directory is not app
// source — it's a vendored AI-harness install (.claude/skills/..., .cursor/,
// .impeccable/, issue #303), a build artifact, or a dependency. Mirrors the
// engine walkDir's skip rule so git-changes targeting can't resurface paths
// the walker would never visit.
function isVendoredPath(rel) {
  const dirSegments = rel.split(/[\\/]/).slice(0, -1);
  return dirSegments.some(
    (seg) =>
      (seg.startsWith('.') && seg !== '.vitepress' && seg !== '.vuepress' && seg !== '.storybook') ||
      seg === 'node_modules' || seg === 'dist' || seg === 'build' || seg === '__pycache__',
  );
}

/**
 * Local paths the agent should point the bundled detector at — never a URL.
 * A URL means a costly Puppeteer browser render, and a probed dev-server port
 * may not even belong to this project. An HTML *file* or a source tree is
 * scanned by the cheap, jsdom-free static engine. This script does NOT run the
 * detector; it just surfaces the target(s) so the agent can run
 * `node <scripts>/detect.mjs --json <targets>` and fold the hits in.
 */
function scanTargets(cwd, git) {
  // 1. Dirty tree wins: scan exactly the markup/style files in flight. It's
  //    what the user is working on, it's a small set, and it's local.
  if (git.isRepo && git.changedFiles.length) {
    const changed = git.changedFiles
      .filter((f) => SCANNABLE_EXT.has(path.extname(f).toLowerCase()))
      .filter((f) => !isVendoredPath(f))
      .filter((f) => fs.existsSync(path.join(cwd, f)));
    if (changed.length) return { targets: changed.slice(0, 50), via: 'git-changes' };
  }
  // 2. Otherwise scan the local source dirs that exist.
  const dirs = SOURCE_DIRS.filter((d) => fs.existsSync(path.join(cwd, d)));
  if (dirs.length) return { targets: dirs, via: 'source-dir' };
  // 3. A root HTML entry, or the project root as a last resort when there's
  //    code but no conventional source dir (walkDir still skips heavy dirs).
  if (fs.existsSync(path.join(cwd, 'index.html'))) return { targets: ['index.html'], via: 'html' };
  if (hasCode(cwd)) return { targets: ['.'], via: 'root' };
  return { targets: [], via: null };
}

export async function gatherSignals(cwd = process.cwd()) {
  const ctx = loadContext(cwd);
  const git = gitSignals(cwd);
  return {
    setup: {
      hasProduct: ctx.hasProduct,
      productPath: ctx.productPath,
      hasDesign: ctx.hasDesign,
      designPath: ctx.designPath,
      hasCode: hasCode(cwd),
      platform: extractPlatform(ctx.product),
    },
    critique: { latest: latestCritique(cwd) },
    git,
    devServer: await devServerSignals(),
    scan: scanTargets(cwd, git),
  };
}

async function cli() {
  const signals = await gatherSignals(process.cwd());
  process.stdout.write(`${JSON.stringify(signals, null, 2)}\n`);
}

function invokedAsScript() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return fs.realpathSync(arg) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  cli();
}
