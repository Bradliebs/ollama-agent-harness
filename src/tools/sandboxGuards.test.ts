import * as path from 'path';
import {
  setSandboxStateProvider,
  resetSandboxStateProvider,
  isSandboxActive,
  evaluateSandboxPath,
  evaluateSandboxNetworkUrl,
  isShellBinaryAllowed,
  SANDBOX_SHELL_ALLOWLIST,
} from './sandboxGuards';

describe('sandboxGuards', () => {
  afterEach(() => {
    resetSandboxStateProvider();
  });

  describe('state provider', () => {
    it('defaults to inactive when no provider wired', () => {
      expect(isSandboxActive()).toBe(false);
    });

    it('reads from the wired provider', () => {
      let active = false;
      setSandboxStateProvider(() => active);
      expect(isSandboxActive()).toBe(false);
      active = true;
      expect(isSandboxActive()).toBe(true);
    });

    it('fail-closed: a throwing provider reports inactive (does not crash callers)', () => {
      setSandboxStateProvider(() => { throw new Error('provider boom'); });
      expect(() => isSandboxActive()).not.toThrow();
      expect(isSandboxActive()).toBe(false);
    });

    it('reset clears the provider', () => {
      setSandboxStateProvider(() => true);
      expect(isSandboxActive()).toBe(true);
      resetSandboxStateProvider();
      expect(isSandboxActive()).toBe(false);
    });
  });

  describe('evaluateSandboxPath', () => {
    const root = path.resolve('/workspace/project');

    it('returns ok when sandbox inactive (no-op)', () => {
      setSandboxStateProvider(() => false);
      expect(evaluateSandboxPath('/etc/passwd', root).ok).toBe(true);
    });

    it('allows paths inside the project root when sandbox active', () => {
      setSandboxStateProvider(() => true);
      const inside = path.resolve(root, 'src/file.ts');
      expect(evaluateSandboxPath(inside, root).ok).toBe(true);
    });

    it('allows the project root itself', () => {
      setSandboxStateProvider(() => true);
      expect(evaluateSandboxPath(root, root).ok).toBe(true);
    });

    it('rejects paths outside the project root when sandbox active', () => {
      setSandboxStateProvider(() => true);
      const decision = evaluateSandboxPath(path.resolve('/etc/passwd'), root);
      expect(decision.ok).toBe(false);
      expect(decision.reason).toMatch(/sandbox/);
    });

    it('rejects parent-traversal paths when sandbox active', () => {
      setSandboxStateProvider(() => true);
      const escape = path.resolve(root, '../sibling');
      expect(evaluateSandboxPath(escape, root).ok).toBe(false);
    });

    it('rejects empty candidate or root when sandbox active', () => {
      setSandboxStateProvider(() => true);
      expect(evaluateSandboxPath('', root).ok).toBe(false);
      expect(evaluateSandboxPath(root, '').ok).toBe(false);
    });
  });

  describe('isShellBinaryAllowed', () => {
    it('allows bare allowlisted binaries', () => {
      expect(isShellBinaryAllowed('git')).toBe(true);
      expect(isShellBinaryAllowed('node')).toBe(true);
      expect(isShellBinaryAllowed('jest')).toBe(true);
    });

    it('allows path-qualified allowlisted binaries by basename', () => {
      expect(isShellBinaryAllowed('/usr/bin/git')).toBe(true);
      expect(isShellBinaryAllowed('C:\\Program Files\\Git\\bin\\git.exe')).toBe(true);
    });

    it('rejects non-allowlisted binaries', () => {
      expect(isShellBinaryAllowed('rm')).toBe(false);
      expect(isShellBinaryAllowed('mv')).toBe(false);
      expect(isShellBinaryAllowed('curl')).toBe(false);
      expect(isShellBinaryAllowed('powershell')).toBe(false);
      expect(isShellBinaryAllowed('mkfs.ext4')).toBe(false);
    });

    it('rejects empty', () => {
      expect(isShellBinaryAllowed('')).toBe(false);
    });

    it('allowlist is non-empty (sanity)', () => {
      expect(SANDBOX_SHELL_ALLOWLIST.size).toBeGreaterThan(10);
    });
  });

  describe('evaluateSandboxNetworkUrl', () => {
    it('returns ok when sandbox inactive (no-op)', () => {
      setSandboxStateProvider(() => false);
      expect(evaluateSandboxNetworkUrl('http://127.0.0.1/').ok).toBe(true);
    });

    describe('when sandbox active', () => {
      beforeEach(() => setSandboxStateProvider(() => true));

      it('allows public https hosts', () => {
        expect(evaluateSandboxNetworkUrl('https://example.com/api').ok).toBe(true);
        expect(evaluateSandboxNetworkUrl('https://api.github.com').ok).toBe(true);
      });

      it('blocks localhost variants', () => {
        expect(evaluateSandboxNetworkUrl('http://localhost/').ok).toBe(false);
        expect(evaluateSandboxNetworkUrl('http://localhost.localdomain/').ok).toBe(false);
      });

      it('blocks loopback IPv4 (127.0.0.0/8)', () => {
        expect(evaluateSandboxNetworkUrl('http://127.0.0.1/').ok).toBe(false);
        expect(evaluateSandboxNetworkUrl('http://127.5.6.7/').ok).toBe(false);
      });

      it('blocks private IPv4 ranges', () => {
        expect(evaluateSandboxNetworkUrl('http://10.0.0.1/').ok).toBe(false);
        expect(evaluateSandboxNetworkUrl('http://192.168.1.1/').ok).toBe(false);
        expect(evaluateSandboxNetworkUrl('http://172.16.0.1/').ok).toBe(false);
        expect(evaluateSandboxNetworkUrl('http://172.31.255.255/').ok).toBe(false);
      });

      it('allows 172.32.0.0+ (just outside private range)', () => {
        expect(evaluateSandboxNetworkUrl('http://172.32.0.1/').ok).toBe(true);
      });

      it('blocks link-local IPv4 (169.254.0.0/16) — includes cloud metadata', () => {
        expect(evaluateSandboxNetworkUrl('http://169.254.169.254/latest/meta-data/').ok).toBe(false);
      });

      it('blocks loopback IPv6', () => {
        expect(evaluateSandboxNetworkUrl('http://[::1]/').ok).toBe(false);
      });

      it('blocks link-local IPv6', () => {
        expect(evaluateSandboxNetworkUrl('http://[fe80::1]/').ok).toBe(false);
      });

      it('blocks .local and .internal TLDs', () => {
        expect(evaluateSandboxNetworkUrl('http://printer.local/').ok).toBe(false);
        expect(evaluateSandboxNetworkUrl('http://api.internal/').ok).toBe(false);
      });

      it('blocks file:// urls', () => {
        expect(evaluateSandboxNetworkUrl('file:///etc/passwd').ok).toBe(false);
      });

      it('blocks unknown protocols', () => {
        expect(evaluateSandboxNetworkUrl('ftp://example.com').ok).toBe(false);
        expect(evaluateSandboxNetworkUrl('gopher://example.com').ok).toBe(false);
      });

      it('rejects malformed urls', () => {
        expect(evaluateSandboxNetworkUrl('not a url').ok).toBe(false);
        expect(evaluateSandboxNetworkUrl('').ok).toBe(false);
      });
    });
  });
});
