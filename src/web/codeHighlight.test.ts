import * as path from 'path';

const highlighter = require(path.join(process.cwd(), 'ui', 'codeHighlight.js')) as {
  highlight: (code: string, language: string) => string | null;
  familyFor: (language: string) => string | null;
};

const strip = (html: string): string => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

describe('code highlighting', () => {
  it('marks keywords, strings, numbers and comments in TypeScript', () => {
    const code = 'const total = 42; // sum\nreturn `ok ${total}` + "x";';
    const html = highlighter.highlight(code, 'ts')!;
    expect(html).toContain('<span class="hl-k">const</span>');
    expect(html).toContain('<span class="hl-n">42</span>');
    expect(html).toContain('<span class="hl-c">// sum</span>');
    expect(html).toContain('<span class="hl-s">&quot;x&quot;</span>');
    expect(strip(html)).toBe(code);
  });

  it('escapes HTML in code so it cannot inject markup', () => {
    const code = '<img src=x onerror="alert(1)"> & <script>alert(2)</script>';
    const html = highlighter.highlight(code, 'html')!;
    expect(html).not.toMatch(/<img|<script/);
    expect(strip(html)).toBe(code);
  });

  it('handles Python, shell, JSON, SQL and diff', () => {
    expect(highlighter.highlight('def f(x):\n    return None  # done', 'python')).toContain('<span class="hl-k">def</span>');
    expect(highlighter.highlight('echo "$HOME" # home', 'bash')).toContain('<span class="hl-c"># home</span>');
    expect(highlighter.highlight('{"name": "x", "n": 1}', 'json')).toContain('<span class="hl-a">&quot;name&quot;</span>');
    expect(highlighter.highlight('SELECT id FROM users', 'sql')).toContain('<span class="hl-k">SELECT</span>');
    expect(highlighter.highlight('@@ -1 +1 @@\n-old\n+new', 'diff')).toContain('<span class="hl-add">+new</span>');
  });

  it('leaves unknown languages and huge blocks alone', () => {
    expect(highlighter.highlight('anything', 'klingon')).toBeNull();
    expect(highlighter.highlight('x'.repeat(25_000), 'js')).toBeNull();
    expect(highlighter.highlight('x', 'constructor')).toBeNull();
    expect(highlighter.highlight('x', '__proto__')).toBeNull();
    expect(highlighter.familyFor('TypeScript')).toBe('js');
  });

  it('stays fast on pathological input', () => {
    const started = Date.now();
    for (const [code, language] of [['a:'.repeat(9_000), 'css'], ['a: '.repeat(6_000), 'css'], ['/* '.repeat(6_000), 'js'], ['<!-- '.repeat(3_500), 'html']]) highlighter.highlight(code, language);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('keeps the text intact for every family', () => {
    const sample = 'a = "b" # c\n/* d */ 1.5 <e f="g"> -- h\n+i\n@@ j';
    for (const language of ['js', 'python', 'bash', 'json', 'css', 'html', 'yaml', 'sql', 'diff', 'go']) {
      expect(strip(highlighter.highlight(sample, language)!)).toBe(sample);
    }
  });
});
