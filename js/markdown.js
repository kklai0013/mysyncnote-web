const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const escapeAttr = value => escapeHtml(value).replace(/`/g, '&#96;');

export function noteStem(path = '') {
  const name = path.split('/').pop() || path;
  return name.replace(/\.md$/i, '');
}

export function parseFrontmatter(source) {
  const result = { properties: {}, body: source };
  if (!source.startsWith('---\n')) return result;
  const end = source.indexOf('\n---', 4);
  if (end < 0) return result;
  const raw = source.slice(4, end).split('\n');
  for (const line of raw) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1).split(',').map(item => item.trim().replace(/^['"]|['"]$/g, ''));
    result.properties[key] = value;
  }
  result.body = source.slice(end + 4).replace(/^\n/, '');
  return result;
}

export function extractHeadings(source) {
  return source.split('\n').map((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    return match ? { level: match[1].length, text: match[2].replace(/[*_`~=[\]]/g, ''), line: index } : null;
  }).filter(Boolean);
}

export function extractTags(source) {
  const tags = new Set();
  const frontmatter = parseFrontmatter(source).properties;
  const raw = frontmatter.tags;
  if (Array.isArray(raw)) raw.forEach(tag => tags.add(String(tag).replace(/^#/, '')));
  else if (raw) String(raw).split(/[ ,]+/).forEach(tag => tags.add(tag.replace(/^#/, '')));
  for (const match of source.matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu)) tags.add(match[2]);
  return [...tags];
}

export function extractLinks(source) {
  const links = [];
  for (const match of source.matchAll(/(!?)\[\[([^\]]+)\]\]/g)) {
    const raw = match[2];
    const [targetPart, alias] = raw.split('|');
    const [target, heading] = targetPart.split('#');
    links.push({ type: 'wiki', embed: match[1] === '!', raw: match[0], target: target.trim(), heading: heading?.trim() || '', alias: alias?.trim() || '' });
  }
  for (const match of source.matchAll(/(!?)\[([^\]]*)\]\(([^)]+)\)/g)) {
    if (/^(https?:|mailto:|tel:)/i.test(match[3])) links.push({ type: 'external', embed: match[1] === '!', label: match[2], target: match[3] });
    else links.push({ type: 'markdown', embed: match[1] === '!', label: match[2], target: decodeURIComponent(match[3].split('#')[0]) });
  }
  return links;
}

function inline(raw, context) {
  const tokens = [];
  let text = String(raw);
  const hold = html => {
    const id = tokens.length;
    tokens.push(html);
    return `\u0000${id}\u0000`;
  };

  text = text.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/(!?)\[\[([^\]]+)\]\]/g, (_, embed, rawTarget) => {
    const [targetAndHeading, alias] = rawTarget.split('|');
    const [target, heading] = targetAndHeading.split('#');
    const resolved = context.resolveWiki?.(target.trim());
    const label = alias?.trim() || heading?.trim() || target.trim();
    if (embed) {
      const embedded = context.embedWiki?.(target.trim());
      if (embedded?.type === 'image') return hold(`<figure class="embed-image"><img data-vault-image="${escapeAttr(embedded.path)}" alt="${escapeAttr(label)}"><figcaption>${escapeHtml(label)}</figcaption></figure>`);
      if (embedded?.html) return hold(`<section class="note-embed" data-wikilink="${escapeAttr(target.trim())}">${embedded.html}</section>`);
    }
    return hold(`<a class="wikilink${resolved ? '' : ' broken-link'}" data-wikilink="${escapeAttr(target.trim())}" data-heading="${escapeAttr(heading || '')}">${escapeHtml(label)}</a>`);
  });
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    if (/^https?:/i.test(src)) return hold(`<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" loading="lazy">`);
    return hold(`<img data-vault-image="${escapeAttr(decodeURIComponent(src))}" alt="${escapeAttr(alt)}" loading="lazy">`);
  });
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    if (/^(https?:|mailto:|tel:)/i.test(href)) return hold(`<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
    return hold(`<a data-file-link="${escapeAttr(decodeURIComponent(href))}">${escapeHtml(label)}</a>`);
  });
  text = escapeHtml(text);
  text = text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>')
    .replace(/(^|\s)#([\p{L}\p{N}_/-]+)/gu, '$1<a class="tag" data-tag="$2">#$2</a>');
  return text.replace(/\u0000(\d+)\u0000/g, (_, id) => tokens[Number(id)]);
}

function renderTable(lines, context) {
  const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
  const headers = cells(lines[0]);
  const rows = lines.slice(2).map(cells);
  return `<table><thead><tr>${headers.map(cell => `<th>${inline(cell, context)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${inline(cell, context)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

export function renderMarkdown(source, context = {}) {
  const { body } = parseFrontmatter(source);
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];
  let inCode = false;
  let codeLang = '';
  let codeLines = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inline(paragraph.join('\n'), context).replace(/\n/g, '<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listItems.length) return;
    const className = listType === 'task' ? ' class="task-list"' : '';
    const tag = listType === 'ordered' ? 'ol' : 'ul';
    html.push(`<${tag}${className}>${listItems.join('')}</${tag}>`);
    listItems = [];
    listType = null;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = line.match(/^```\s*([^ ]*)/);
    if (fence) {
      flushParagraph(); flushList();
      if (!inCode) { inCode = true; codeLang = fence[1] || ''; codeLines = []; }
      else { html.push(`<pre><code class="language-${escapeAttr(codeLang)}">${escapeHtml(codeLines.join('\n'))}</code></pre>`); inCode = false; }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }

    if (line.includes('|') && lines[index + 1]?.match(/^\s*\|?\s*:?-{3,}/)) {
      flushParagraph(); flushList();
      const tableLines = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) tableLines.push(lines[index++]);
      index--;
      html.push(renderTable(tableLines, context));
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      flushParagraph(); flushList();
      const level = heading[1].length;
      const id = heading[2].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
      html.push(`<h${level} id="${escapeAttr(id)}">${inline(heading[2], context)}</h${level}>`);
      continue;
    }
    const callout = line.match(/^>\s*\[!([^\]]+)\]\s*(.*)$/);
    if (callout) {
      flushParagraph(); flushList();
      const bodyLines = [];
      while (lines[index + 1]?.startsWith('>')) bodyLines.push(lines[++index].replace(/^>\s?/, ''));
      html.push(`<aside class="callout"><strong>${escapeHtml(callout[1])}${callout[2] ? ` · ${inline(callout[2], context)}` : ''}</strong>${bodyLines.length ? `<p>${inline(bodyLines.join('\n'), context)}</p>` : ''}</aside>`);
      continue;
    }
    if (line.startsWith('>')) {
      flushParagraph(); flushList();
      const quotes = [line.replace(/^>\s?/, '')];
      while (lines[index + 1]?.startsWith('>')) quotes.push(lines[++index].replace(/^>\s?/, ''));
      html.push(`<blockquote>${quotes.map(q => inline(q, context)).join('<br>')}</blockquote>`);
      continue;
    }
    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (task) {
      flushParagraph();
      if (listType && listType !== 'task') flushList();
      listType = 'task';
      listItems.push(`<li><input type="checkbox" disabled ${task[1].toLowerCase() === 'x' ? 'checked' : ''}> ${inline(task[2], context)}</li>`);
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const type = ordered ? 'ordered' : 'unordered';
      if (listType && listType !== type) flushList();
      listType = type;
      listItems.push(`<li>${inline((unordered || ordered)[1], context)}</li>`);
      continue;
    }
    if (/^([-*_])(?:\s*\1){2,}\s*$/.test(line)) { flushParagraph(); flushList(); html.push('<hr>'); continue; }
    flushList();
    paragraph.push(line);
  }
  if (inCode) html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  flushParagraph(); flushList();
  return html.join('\n');
}

export function buildIndex(entries) {
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  const byStem = new Map();
  for (const entry of entries) {
    const stem = noteStem(entry.path).toLowerCase();
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(entry);
  }
  const resolve = (target, sourcePath = '') => {
    if (!target) return null;
    const clean = target.replace(/\\/g, '/').replace(/\.md$/i, '');
    const direct = [...byPath.values()].find(entry => entry.path.replace(/\.md$/i, '').toLowerCase() === clean.toLowerCase());
    if (direct) return direct;
    const sourceDir = sourcePath.split('/').slice(0, -1).join('/');
    const relative = [...byPath.values()].find(entry => entry.path.replace(/\.md$/i, '').toLowerCase() === `${sourceDir}/${clean}`.replace(/^\//, '').toLowerCase());
    if (relative) return relative;
    return byStem.get(noteStem(clean).toLowerCase())?.[0] || null;
  };
  const edges = [];
  const backlinks = new Map(entries.map(entry => [entry.path, []]));
  for (const source of entries) {
    source.links = extractLinks(source.content);
    source.tags = extractTags(source.content);
    source.headings = extractHeadings(source.content);
    for (const link of source.links.filter(item => item.type !== 'external')) {
      const target = resolve(link.target, source.path);
      if (!target) { edges.push({ source: source.path, target: link.target, broken: true }); continue; }
      if (target.path === source.path) continue;
      edges.push({ source: source.path, target: target.path, broken: false });
      backlinks.get(target.path)?.push({ source: source.path, link });
    }
  }
  return { entries, byPath, byStem, resolve, edges, backlinks };
}

export function replaceWikiTarget(source, oldStem, newTarget) {
  const escaped = oldStem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.replace(new RegExp(`(!?\\[\\[)(?:[^\\]|]+/)?${escaped}(?=([#|\\]]))`, 'gi'), `$1${newTarget}`);
}
