// Citation rendering for research answers.
//
// Moved out of app.js to shrink it. Collects nothing itself: app.js passes the
// per-turn web_read sources in.
// Loaded before app.js; shares its global scope (classic script).

/**
 * Pull a human-friendly title for a citation from the web_read output.
 * The web_read tool prepends "Content from <url>:" then the body. We
 * try to find the first non-trivial line that looks like a title.
 */
function extractCitationTitle(toolOutput, url) {
  if (!toolOutput) return url;
  const lines = String(toolOutput).split('\n').map((l) => l.trim()).filter(Boolean);
  // Skip the "Content from <url>:" header.
  for (const line of lines) {
    if (line.startsWith('Content from ')) continue;
    if (line.length < 8 || line.length > 120) continue;
    return line;
  }
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch(e){ return url; }
}

/**
 * Attach a numbered citation list under an assistant message and
 * rewrite raw URL mentions in the visible reply to [n] superscripts.
 * Mutates the rendered DOM only — chatMessages history keeps the
 * original text so regenerate / save / copy stay clean.
 */
function attachCitations(msgEl, citations, originalText) {
  if (!msgEl || !citations || citations.length === 0) return;
  const body = msgEl.querySelector('.msg-body');
  const content = msgEl.querySelector('.msg-content');
  if (!body || !content) return;

  // Rewrite URL mentions in the rendered HTML to [n] superscript links.
  citations.forEach((c, i) => {
    const n = i + 1;
    const url = c.url;
    const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Replace bare URL text (not already inside <a>) with the original
    // URL plus a [n] superscript link.
    const re = new RegExp('(?<![">\\w/])' + escapedUrl + '(?![">\\w/])', 'g');
    content.innerHTML = content.innerHTML.replace(re, function (match) {
      return match + '<sup><a href="' + url + '" target="_blank" rel="noopener" class="citation-sup" title="' + esc(c.title) + '">[' + n + ']</a></sup>';
    });
  });

  // Append the source list.
  const wrap = document.createElement('div');
  wrap.className = 'citations';
  wrap.innerHTML = '<div class="citations-label">Sources</div>';
  citations.forEach((c, i) => {
    const item = document.createElement('a');
    item.className = 'citation-item';
    item.href = c.url;
    item.target = '_blank';
    item.rel = 'noopener';
    let host = c.url;
    try { host = new URL(c.url).hostname.replace(/^www\./, ''); } catch(e){}
    item.innerHTML = '<span class="citation-num">[' + (i + 1) + ']</span><span class="citation-title">' + esc(c.title) + '</span><span class="citation-host">' + esc(host) + '</span>';
    wrap.appendChild(item);
  });
  body.appendChild(wrap);
}

