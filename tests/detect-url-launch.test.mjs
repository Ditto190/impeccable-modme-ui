import { describe, test, expect, afterEach } from 'bun:test';
import { launchBrowser, detectUrl, splitScanUrl } from '../cli/engine/engines/browser/detect-url.mjs';

// launchBrowser prefers the system-installed Chrome on Windows to dodge the
// bundled-Chrome GPU crash-loop (issue #372), and keeps the pinned bundled
// build everywhere else. The function takes the puppeteer module as a
// parameter, so a fake lets us assert the launch strategy without a real
// browser or a real OS.

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(value) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
});

function makePuppeteer({ failChannel = false } = {}) {
  const calls = [];
  const fakeBrowser = { __fake: true };
  return {
    calls,
    fakeBrowser,
    mod: {
      default: {
        async launch(opts) {
          calls.push(opts);
          if (failChannel && opts.channel === 'chrome') {
            throw new Error('Could not find Chrome (channel: chrome)');
          }
          return fakeBrowser;
        },
      },
    },
  };
}

describe('launchBrowser', () => {
  test('Windows: prefers system Chrome via channel:chrome', async () => {
    setPlatform('win32');
    const p = makePuppeteer();
    const browser = await launchBrowser(p.mod, { headless: true, args: ['--foo'] });

    expect(browser).toBe(p.fakeBrowser);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].channel).toBe('chrome');
    expect(p.calls[0].headless).toBe(true);
    expect(p.calls[0].args).toEqual(['--foo']);
  });

  test('Windows: falls back to bundled when system Chrome is unavailable', async () => {
    setPlatform('win32');
    const p = makePuppeteer({ failChannel: true });
    const browser = await launchBrowser(p.mod, { headless: true, args: [] });

    expect(browser).toBe(p.fakeBrowser);
    expect(p.calls).toHaveLength(2);
    expect(p.calls[0].channel).toBe('chrome'); // first attempt
    expect(p.calls[1].channel).toBeUndefined(); // fallback: bundled, no channel
  });

  test('non-Windows: uses bundled Chrome directly, no channel', async () => {
    setPlatform('linux');
    const p = makePuppeteer();
    const browser = await launchBrowser(p.mod, { headless: true, args: [] });

    expect(browser).toBe(p.fakeBrowser);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].channel).toBeUndefined();
  });

  test('non-Windows: never attempts channel:chrome even if it would succeed', async () => {
    setPlatform('darwin');
    const p = makePuppeteer();
    await launchBrowser(p.mod, {});

    expect(p.calls.every(c => c.channel === undefined)).toBe(true);
  });
});

describe('splitScanUrl', () => {
  test('strips http(s) userinfo and returns credentials', () => {
    expect(splitScanUrl('https://user:pass@example.com')).toEqual({
      href: 'https://example.com/',
      credentials: { username: 'user', password: 'pass' },
    });
    expect(splitScanUrl('https://user:p%40ss@example.com/path?q=1')).toEqual({
      href: 'https://example.com/path?q=1',
      credentials: { username: 'user', password: 'p@ss' },
    });
    expect(splitScanUrl('https://user@example.com')).toEqual({
      href: 'https://example.com/',
      credentials: { username: 'user', password: '' },
    });
    expect(splitScanUrl('http://:secret@host.com/')).toEqual({
      href: 'http://host.com/',
      credentials: { username: '', password: 'secret' },
    });
  });

  test('preserves original string when no userinfo', () => {
    expect(splitScanUrl('https://example.com')).toEqual({
      href: 'https://example.com',
      credentials: null,
    });
    expect(splitScanUrl('https://example.com/path?email=a@b.com')).toEqual({
      href: 'https://example.com/path?email=a@b.com',
      credentials: null,
    });
  });

  test('handles IPv6 and non-http(s) URLs', () => {
    expect(splitScanUrl('https://user:pass@[::1]:8080/x')).toEqual({
      href: 'https://[::1]:8080/x',
      credentials: { username: 'user', password: 'pass' },
    });
    expect(splitScanUrl('file:///tmp/a.html')).toEqual({
      href: 'file:///tmp/a.html',
      credentials: null,
    });
  });

  test('returns original string for invalid URLs', () => {
    expect(splitScanUrl('not a url')).toEqual({
      href: 'not a url',
      credentials: null,
    });
  });
});

function makeFakeBrowser() {
  const calls = { authenticate: [], goto: [] };
  const page = {
    on() {},
    async setViewport() {},
    async authenticate(creds) { calls.authenticate.push(creds); },
    async goto(url, opts) { calls.goto.push({ url, opts }); },
    async evaluate(fn) {
      if (typeof fn === 'function' && fn.toString().includes('impeccableDetect')) {
        return [{ findings: [{ type: 'low-contrast', detail: 'x', ignoreValue: '', severity: '' }] }];
      }
      return [];
    },
    async close() {},
  };
  return {
    calls,
    browser: {
      async newPage() { return page; },
    },
  };
}

describe('detectUrl credential redaction', () => {
  test('authenticates with stripped URL and redacts findings', async () => {
    const { calls, browser } = makeFakeBrowser();
    const findings = await detectUrl('https://user:p%40ss@example.com/path', {
      browser,
      visualContrast: false,
      contentHidden: false,
    });

    expect(calls.authenticate).toEqual([{ username: 'user', password: 'p@ss' }]);
    expect(calls.goto).toHaveLength(1);
    expect(calls.goto[0].url).toBe('https://example.com/path');
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.file).toBe('https://example.com/path');
    }
  });

  test('does not authenticate when URL has no userinfo', async () => {
    const { calls, browser } = makeFakeBrowser();
    const url = 'https://example.com/path';
    const findings = await detectUrl(url, {
      browser,
      visualContrast: false,
      contentHidden: false,
    });

    expect(calls.authenticate).toEqual([]);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.file).toBe(url);
    }
  });
});
