import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  extractMatchingSourceCss,
  findSvelteComponentManifest,
  inlineSvelteComponentAccept,
  mergeCssIntoSvelteSource,
  reindentPreservingStructure,
  scaffoldSvelteComponentSession,
} from '../skill/scripts/live/svelte-component.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_NODE_MODULES = join(__dirname, '..', 'node_modules');

const ROUTE_SOURCE = `<script>
  let stages = [
    { label: 'Review', detail: 'Bots comment', active: true },
    { label: 'Resolve', detail: 'Agent fixes', active: false },
  ];
  let footerNote = 'All quiet.';
</script>

<main>
  <ol class="pit-board">
    {#each stages as stage, i}
      <li class="stage">
        <span class="label">{stage.label}</span>
        <p class="detail">{stage.detail}</p>
      </li>
    {/each}
  </ol>
  <p class="footer">{footerNote}</p>
</main>

<style>
  .pit-board {
    border-top: 1px solid #333;
    display: flex;
  }
  .stage { padding: 8px; }
  .footer { color: gray; }
</style>
`;

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe('svelte component scaffold + accept pipeline', () => {
  let tmp;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'impeccable-svelte-accept-')));
    // The scaffolder resolves the app's svelte compiler; link this repo's.
    mkdirSync(join(tmp, 'node_modules'), { recursive: true });
    try {
      symlinkSync(join(REPO_NODE_MODULES, 'svelte'), join(tmp, 'node_modules', 'svelte'), 'dir');
    } catch {
      cpSync(join(REPO_NODE_MODULES, 'svelte'), join(tmp, 'node_modules', 'svelte'), { recursive: true });
    }
    write(tmp, 'package.json', JSON.stringify({ name: 'app', dependencies: { svelte: '^5' } }));
    write(tmp, 'src/routes/+page.svelte', ROUTE_SOURCE);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function scaffold(id = 'testacc1') {
    // The picked element spans the <ol> block: lines 10-17 (1-indexed).
    const originalLines = ROUTE_SOURCE.split('\n').slice(9, 17);
    assert.match(originalLines[0], /<ol/);
    assert.match(originalLines[originalLines.length - 1], /<\/ol>/);
    return scaffoldSvelteComponentSession({
      id,
      count: 2,
      sourceFile: 'src/routes/+page.svelte',
      sourceStartLine: 10,
      sourceEndLine: 17,
      originalLines,
      cwd: tmp,
    });
  }

  it('scaffolds a v2 contract with the each collection as one structured prop', () => {
    const session = scaffold();
    assert.equal(session.fallback, undefined);
    assert.equal(session.manifest.contractVersion, 2);
    const collection = session.propContract.find((c) => c.kind === 'collection');
    assert.equal(collection.prop, 'stages');
    assert.equal(collection.item.rootTag, 'li');
    const v1 = readFileSync(join(tmp, session.componentDir, 'v1.svelte'), 'utf-8');
    assert.match(v1, /\{#each stages as stage, i\}/);
    assert.match(v1, /\{stage\.label\}/);
    assert.match(v1, /let \{ stages = \[\] \} = \$props\(\)/);
    // Stub CSS is seeded from the route's matching rules.
    assert.match(v1, /border-top: 1px solid #333/);
  });

  it('falls back to source-preview for markup with component tags', () => {
    const res = scaffoldSvelteComponentSession({
      id: 'fallb1',
      count: 3,
      sourceFile: 'src/routes/+page.svelte',
      sourceStartLine: 1,
      sourceEndLine: 1,
      originalLines: ['<Card title={x} />'],
      cwd: tmp,
    });
    assert.equal(res.fallback, 'source-preview');
    assert.match(res.reason, /component tag/);
  });

  it('accept merges CSS instead of appending: superseded rules are replaced, dead branches pruned', () => {
    const session = scaffold('acc2');
    // Agent authors variant 1: arrows instead of divider borders, one param.
    write(tmp, join(session.componentDir, 'v1.svelte'), `<script>
  /** @type {{ stages?: Array<Record<string, unknown>> }} */
  let { stages = [] } = $props();
</script>

<ol class="pit-board">
  {#each stages as stage, i}
    <li class="stage">
      <span class="label">{stage.label}</span>
      <p class="detail">{stage.detail}</p>
    </li>
  {/each}
</ol>

<style>
  .pit-board {
    display: flex;
    clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%);
  }
  .stage { padding: calc(var(--p-depth, 6px) + 2px); }
  :global([data-p-density="airy"]) .stage { margin: 16px; }
  :global([data-p-density="snug"]) .stage { margin: 4px; }
</style>
`);
    write(tmp, join(session.componentDir, 'params.json'), JSON.stringify({
      1: [
        { id: 'depth', kind: 'range', min: 0, max: 20, step: 1, default: 6, label: 'Depth' },
        { id: 'density', kind: 'steps', default: 'airy', label: 'Density', options: [
          { value: 'airy', label: 'Airy' }, { value: 'snug', label: 'Snug' },
        ] },
      ],
    }));

    const manifest = findSvelteComponentManifest('acc2', tmp);
    const result = inlineSvelteComponentAccept(manifest, 1, { depth: 10, density: 'snug' }, tmp);
    assert.equal(result.handled, true, result.error);

    const out = readFileSync(join(tmp, 'src/routes/+page.svelte'), 'utf-8');
    // Loop restored with original expressions, one each block only.
    assert.equal(out.split('{#each stages as stage, i}').length - 1, 1);
    // Superseded divider border is GONE (replaced, not shadowed).
    assert.doesNotMatch(out, /border-top: 1px solid #333/);
    assert.match(out, /clip-path/);
    // Exactly one .pit-board rule.
    assert.equal(out.split('.pit-board {').length - 1, 1);
    // Range baked with paren-aware substitution.
    assert.match(out, /padding: calc\(10 \+ 2px\)/);
    // Steps: chosen branch folded into the .stage rule, other branch dropped,
    // no data-p attributes anywhere.
    assert.match(out, /margin: 4px/);
    assert.equal(out.split(/\.stage \{/).length - 1, 1);
    assert.doesNotMatch(out, /margin: 16px/);
    assert.doesNotMatch(out, /data-p-/);
    assert.doesNotMatch(out, /var\(--p-/);
    // The untouched .footer rule survives.
    assert.match(out, /\.footer \{ color: gray; \}/);
    // Self-check reports clean.
    assert.equal(result.verify.clean, true, JSON.stringify(result.verify.findings));
  });

  it('preserves the variant markup indentation structure', () => {
    const session = scaffold('acc3');
    write(tmp, join(session.componentDir, 'v1.svelte'), `<script>
  let { stages = [] } = $props();
</script>

<ol class="pit-board">
  {#each stages as stage, i}
    <li class="stage">
      <div class="deep">
        <span class="label">{stage.label}</span>
      </div>
    </li>
  {/each}
</ol>

<style>
  .deep { display: block; }
</style>
`);
    const manifest = findSvelteComponentManifest('acc3', tmp);
    const result = inlineSvelteComponentAccept(manifest, 1, null, tmp);
    assert.equal(result.handled, true, result.error);
    const out = readFileSync(join(tmp, 'src/routes/+page.svelte'), 'utf-8');
    const lines = out.split('\n');
    const deepIdx = lines.findIndex((l) => l.includes('<div class="deep">'));
    const labelIdx = lines.findIndex((l) => l.includes('span class="label"'));
    const deepIndent = lines[deepIdx].match(/^\s*/)[0].length;
    const labelIndent = lines[labelIdx].match(/^\s*/)[0].length;
    // Nested structure survives: label sits deeper than its parent div.
    assert.equal(labelIndent > deepIndent, true, `expected nesting, got ${deepIndent} vs ${labelIndent}`);
  });

  it('reindentPreservingStructure keeps relative depth', () => {
    const out = reindentPreservingStructure(['  <a>', '    <b>', '  </a>'], '      ');
    assert.deepEqual(out, ['      <a>', '        <b>', '      </a>']);
  });

  it('mergeCssIntoSvelteSource creates a style block when none exists', () => {
    const { text } = mergeCssIntoSvelteSource('<div class="x">hi</div>', '.x { color: red; }');
    assert.match(text, /<style>\n\s+\.x \{ color: red; \}\n<\/style>/);
  });

  it('extractMatchingSourceCss picks only rules that style the selection', () => {
    const css = extractMatchingSourceCss(ROUTE_SOURCE, '<ol class="pit-board"><li class="stage">x</li></ol>');
    assert.match(css, /\.pit-board/);
    assert.match(css, /\.stage/);
    assert.doesNotMatch(css, /\.footer/);
  });
});
