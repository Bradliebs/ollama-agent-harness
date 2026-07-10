import * as path from 'path';

const followUps = require(path.join(process.cwd(), 'ui', 'followUps.js')) as {
  computeFollowUps: (userText: string, assistantText: string, max?: number) => string[];
  extractFiles: (text: string) => string[];
};

describe('ui follow-up suggestion chips', () => {
  describe('extractFiles', () => {
    it('returns distinct basenames for known source extensions', () => {
      const files = followUps.extractFiles('Edited src/web/server.ts and ui/app.js plus server.ts again.');
      expect(files).toEqual(['server.ts', 'app.js']);
    });

    it('returns an empty array when no files are mentioned', () => {
      expect(followUps.extractFiles('No files here, just prose.')).toEqual([]);
      expect(followUps.extractFiles('')).toEqual([]);
    });
  });

  describe('computeFollowUps', () => {
    it('names the file in the diff suggestion when exactly one is found', () => {
      const out = followUps.computeFollowUps('update the parser', 'I changed src/parser.ts to fix it.');
      expect(out).toContain('Show a diff of parser.ts.');
    });

    it('falls back to the generic diff suggestion when several files are mentioned', () => {
      const out = followUps.computeFollowUps('refactor', 'Touched a.ts, b.ts and c.ts.');
      expect(out).toContain('Show a diff of the changes.');
      expect(out.some((s) => s.startsWith('Show a diff of a.ts'))).toBe(false);
    });

    it('prioritizes an error diagnosis when the reply reports a failure', () => {
      const out = followUps.computeFollowUps('run it', 'It threw an Error: undefined is not a function.');
      expect(out[0]).toBe('Diagnose the error and propose a fix.');
    });

    it('suggests tests when code is present without an error', () => {
      const out = followUps.computeFollowUps('write a helper', 'Here:\n```ts\nexport const x = 1;\n```');
      expect(out).toContain('Add tests for that code.');
    });

    it('always returns generic fallbacks and caps the count', () => {
      const out = followUps.computeFollowUps('', '');
      expect(out).toContain('Summarize this in 3 bullets.');
      expect(out.length).toBeLessThanOrEqual(3);
    });

    it('honors a custom max', () => {
      const out = followUps.computeFollowUps('how does this work', 'It uses Error handling for 42 cases in main.ts.', 2);
      expect(out).toHaveLength(2);
    });

    it('never returns duplicate suggestions', () => {
      const out = followUps.computeFollowUps('why', 'Error in code:\n```js\nthrow new Error();\n```\nSee main.js with 99 retries.');
      expect(new Set(out).size).toBe(out.length);
    });
  });
});
