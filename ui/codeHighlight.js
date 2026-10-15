// Syntax highlighting for fenced code blocks in chat replies. Deliberately
// small and dependency-free: one ordered list of token patterns per language
// family (comments, strings, numbers, keywords, ...), everything else plain.
// The output escapes all text, so it is safe to assign to innerHTML.
(function attachCodeHighlight(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.HarnessCodeHighlight = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createCodeHighlightApi() {
  // Bigger blocks stay plain: some patterns slow down on pathological input.
  const MAX_CHARS = 20000;

  const words = (list) => '\\b(?:' + list.trim().split(/\s+/).join('|') + ')\\b';
  const DQ = '"(?:\\\\.|[^"\\\\\\n])*"';
  const SQ = "'(?:\\\\.|[^'\\\\\\n])*'";
  const NUM = '\\b(?:0[xX][\\da-fA-F_]+|0[bB][01_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?[nfFlLuU]?)\\b';
  const C_COMMENTS = ['c', '\\/\\/[^\\n]*'];
  const BLOCK_COMMENT = ['c', '\\/\\*[\\s\\S]*?\\*\\/'];
  const HASH_COMMENT = ['c', '#[^\\n]*'];

  const JS_KEYWORDS = words('as async await break case catch class const continue debugger default delete do else enum export extends finally for from function if implements import in instanceof interface keyof let new of private protected public readonly return static switch throw try typeof var void while with yield');
  const C_LIKE_KEYWORDS = words('abstract as async await break case catch chan char class const continue def default defer do double else enum extends extern final finally float fn for func go goto if impl implements import in int interface let long loop match mod module mut namespace new override package private protected pub public readonly ref return select short signed sizeof static struct super switch synchronized template throw throws trait try type typedef union unsafe unsigned use using var virtual void volatile where while yield');

  const grammars = {
    js: [C_COMMENTS, BLOCK_COMMENT, ['s', '`(?:\\\\[\\s\\S]|[^\\\\`])*`'], ['s', DQ], ['s', SQ], ['n', NUM], ['l', words('true false null undefined NaN Infinity this super')], ['k', JS_KEYWORDS]],
    clike: [C_COMMENTS, BLOCK_COMMENT, ['s', DQ], ['s', SQ], ['s', '`[^`]*`'], ['n', NUM], ['l', words('true false null nil None self Self this NULL nullptr')], ['k', C_LIKE_KEYWORDS]],
    python: [HASH_COMMENT, ['s', '[rRbBfFuU]{0,2}"""[\\s\\S]*?"""'], ['s', "[rRbBfFuU]{0,2}'''[\\s\\S]*?'''"], ['s', '[rRbBfFuU]{0,2}' + DQ], ['s', '[rRbBfFuU]{0,2}' + SQ], ['n', NUM], ['l', words('True False None self cls')], ['k', words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield print')]],
    shell: [HASH_COMMENT, ['s', DQ], ['s', "'[^']*'"], ['l', '\\$(?:\\{[^}\\n]*\\}|[\\w:]+|[?$#@*!])'], ['n', NUM], ['k', words('if then else elif fi for foreach do done case esac function in while until export local return break continue param begin process end try catch finally throw switch')]],
    json: [['a', DQ + '(?=\\s*:)'], ['s', DQ], ['n', '-?' + NUM], ['l', words('true false null')]],
    css: [BLOCK_COMMENT, ['s', DQ], ['s', SQ], ['k', '@[\\w-]+'], ['n', '#[\\da-fA-F]{3,8}\\b'], ['a', '[\\w-]+(?=\\s*:[^;{}\\n]{0,200}[;}])'], ['n', '-?\\b\\d+(?:\\.\\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?\\b']],
    markup: [['c', '<!--[\\s\\S]*?-->'], ['t', '<\\/?[\\w:.-]+'], ['t', '\\/?>'], ['s', DQ], ['s', SQ], ['a', '\\b[\\w:-]+(?==)']],
    yaml: [HASH_COMMENT, ['a', '^[ \\t]*(?:- )?[\\w./-]+(?=:(?:\\s|$))'], ['s', DQ], ['s', SQ], ['n', NUM], ['l', words('true false null yes no on off')]],
    sql: [['c', '--[^\\n]*'], BLOCK_COMMENT, ['s', "'(?:''|[^'])*'"], ['n', NUM], ['l', words('null true false')], ['k', words('select from where and or not insert into values update set delete create table alter drop index view join left right inner outer full on as group by order having limit offset union all distinct case when then else end primary key foreign references default unique begin commit rollback with returning exists between like in is')]],
    diff: [['h', '^@@[^\\n]*'], ['add', '^\\+[^\\n]*'], ['del', '^-[^\\n]*'], ['c', '^(?:diff|index|---|\\+\\+\\+) [^\\n]*']],
  };
  // SQL keywords are case-insensitive; markup and YAML/diff patterns anchor on lines.
  const flags = { sql: 'gim', yaml: 'gm', diff: 'gm' };

  const aliases = {
    js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', typescript: 'js', tsx: 'js', mts: 'js',
    json: 'json', jsonc: 'json', json5: 'json',
    py: 'python', python: 'python', python3: 'python',
    sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell', ps: 'shell', ps1: 'shell', powershell: 'shell', pwsh: 'shell', bat: 'shell', cmd: 'shell', dockerfile: 'shell', docker: 'shell', makefile: 'shell', make: 'shell',
    css: 'css', scss: 'css', less: 'css',
    html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', xaml: 'markup', csproj: 'markup',
    yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml',
    sql: 'sql', psql: 'sql', mysql: 'sql', sqlite: 'sql',
    diff: 'diff', patch: 'diff',
    c: 'clike', h: 'clike', cpp: 'clike', 'c++': 'clike', cc: 'clike', hpp: 'clike', cs: 'clike', csharp: 'clike', java: 'clike', kotlin: 'clike', kt: 'clike', go: 'clike', golang: 'clike', rust: 'clike', rs: 'clike', swift: 'clike', php: 'clike', dart: 'clike', scala: 'clike', groovy: 'clike',
  };

  const compiled = {};
  function compile(family) {
    if (!compiled[family]) {
      const rules = grammars[family];
      compiled[family] = {
        classes: rules.map((rule) => rule[0]),
        regex: new RegExp(rules.map((rule) => '(' + rule[1] + ')').join('|'), flags[family] || 'g'),
      };
    }
    return compiled[family];
  }

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function familyFor(language) {
    const key = String(language || '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : null;
  }

  /** Highlighted, escaped HTML for `code`, or null for an unknown language or a huge block. */
  function highlight(code, language) {
    const family = familyFor(language);
    if (!family || typeof code !== 'string' || code.length > MAX_CHARS) return null;
    const { classes, regex } = compile(family);
    regex.lastIndex = 0;
    let html = '';
    let last = 0;
    let match;
    while ((match = regex.exec(code)) !== null) {
      if (match[0] === '') { regex.lastIndex += 1; continue; }
      const group = match.findIndex((value, index) => index > 0 && value !== undefined);
      html += escapeHtml(code.slice(last, match.index));
      html += '<span class="hl-' + classes[group - 1] + '">' + escapeHtml(match[0]) + '</span>';
      last = match.index + match[0].length;
    }
    return html + escapeHtml(code.slice(last));
  }

  /** Highlight a rendered `<code class="language-x">` element in place. */
  function highlightElement(codeEl) {
    if (!codeEl || codeEl.dataset.highlighted) return false;
    const languageClass = Array.from(codeEl.classList || []).find((name) => name.startsWith('language-'));
    if (!languageClass) return false;
    const html = highlight(codeEl.textContent || '', languageClass.slice('language-'.length));
    if (html === null) return false;
    codeEl.innerHTML = html;
    codeEl.dataset.highlighted = '1';
    return true;
  }

  return { highlight, highlightElement, familyFor };
});
