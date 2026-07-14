function continuationPrefix(line) {
  const task = line.match(/^(\s*[-*+]\s+\[[ xX]\]\s+)/);
  if (task) return task[1].replace(/[xX]/, ' ');
  const bullet = line.match(/^(\s*[-*+]\s+)/);
  if (bullet) return bullet[1];
  const ordered = line.match(/^(\s*)(\d+)([.)]\s+)/);
  if (ordered) return `${ordered[1]}${Number(ordered[2]) + 1}${ordered[3]}`;
  return line.match(/^(\s*>\s?)/)?.[1] || '';
}

function syntax(text) {
  const span = document.createElement('span');
  span.className = 'live-syntax'; span.textContent = text; return span;
}

function decorateToken(raw) {
  const token = document.createElement('span'); token.className = 'live-token';
  const tag = raw.match(/^(\s*)#([\p{L}\p{N}_/-]+)$/u);
  if (tag) {
    if (tag[1]) token.append(document.createTextNode(tag[1]));
    const label = document.createElement('span'); label.className = 'live-tag'; label.dataset.tag = tag[2]; label.textContent = `#${tag[2]}`; label.title = `搜尋 #${tag[2]}`;
    token.append(label); return token;
  }
  const wiki = raw.match(/^(!?)\[\[([^\]]*)\]\]$/);
  if (wiki) {
    const [targetPart, alias] = wiki[2].split('|');
    const [target, heading] = targetPart.split('#');
    token.classList.add('live-wikilink'); token.dataset.wikilink = target.trim(); token.dataset.heading = heading?.trim() || '';
    token.title = '點一下開啟連結';
    token.append(syntax(`${wiki[1]}[[`));
    const label = document.createElement('span'); label.className = 'live-link-label'; label.textContent = wiki[2]; token.append(label, syntax(']]')); return token;
  }
  const markdownLink = raw.match(/^\[([^\]]*)\]\(([^)]*)\)$/);
  if (markdownLink) {
    token.classList.add('live-markdown-link'); token.dataset.href = markdownLink[2]; token.title = '點一下開啟連結';
    token.append(syntax('[')); const label = document.createElement('span'); label.className = 'live-link-label'; label.textContent = markdownLink[1]; token.append(label, syntax(`](${markdownLink[2]})`)); return token;
  }
  for (const [pattern, className, marker] of [
    [/^\*\*([\s\S]*)\*\*$/, 'live-bold', '**'], [/^__([\s\S]*)__$/, 'live-bold', '__'],
    [/^~~([\s\S]*)~~$/, 'live-strike', '~~'], [/^==([\s\S]*)==$/, 'live-highlight', '=='],
    [/^`([\s\S]*)`$/, 'live-code', '`'], [/^\*([^*]+)\*$/, 'live-italic', '*'], [/^_([^_]+)_$/, 'live-italic', '_']
  ]) {
    const match = raw.match(pattern); if (!match) continue;
    token.classList.add(className); token.append(syntax(marker)); const content = document.createElement('span'); content.textContent = match[1]; token.append(content, syntax(marker)); return token;
  }
  token.textContent = raw; return token;
}

function decorateLine(line) {
  const wrapper = document.createElement('span'); wrapper.className = 'live-line';
  const heading = line.match(/^(#{1,6})(\s+)/);
  let body = line;
  if (heading) { wrapper.classList.add(`live-heading-${heading[1].length}`); wrapper.append(syntax(heading[0])); body = line.slice(heading[0].length); }
  else {
    const marker = line.match(/^(\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?))/);
    if (marker) { wrapper.append(syntax(marker[0])); body = line.slice(marker[0].length); }
  }
  const pattern = /(!?\[\[[^\]\n]*\]\]|\[[^\]\n]*\]\([^\)\n]*\)|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|==[^=\n]+==|(?<!\*)\*[^*\n]+\*(?!\*)|(?<!_)_[^_\n]+_(?!_)|(?:^|\s)#[\p{L}\p{N}_/-]+)/gu;
  let cursor = 0;
  for (const match of body.matchAll(pattern)) {
    if (match.index > cursor) wrapper.append(document.createTextNode(body.slice(cursor, match.index)));
    wrapper.append(decorateToken(match[0])); cursor = match.index + match[0].length;
  }
  if (cursor < body.length) wrapper.append(document.createTextNode(body.slice(cursor)));
  return wrapper;
}

export class LiveMarkdownEditor {
  constructor(container, { onChange, onLink, onFileLink, onTag, onCursor, onPasteFiles } = {}) {
    this.container = container; this.onChange = onChange; this.onLink = onLink; this.onFileLink = onFileLink; this.onTag = onTag; this.onCursor = onCursor; this.onPasteFiles = onPasteFiles;
    this.source = ''; this.composing = false; this.rendering = false; this.history = []; this.historyIndex = -1;
    container.contentEditable = 'true'; container.spellcheck = true; container.setAttribute('role', 'textbox'); container.setAttribute('aria-multiline', 'true');
    container.addEventListener('beforeinput', event => {
      if (event.inputType !== 'insertParagraph' && event.inputType !== 'insertLineBreak') return;
      event.preventDefault(); const { start, end } = this.getSelection();
      const lineStart = this.source.lastIndexOf('\n', start - 1) + 1; const prefix = continuationPrefix(this.source.slice(lineStart, start));
      this.replaceRange(start, end, `\n${prefix}`);
    });
    container.addEventListener('paste', event => {
      if (event.clipboardData?.files?.length) { event.preventDefault(); this.onPasteFiles?.([...event.clipboardData.files]); return; }
      event.preventDefault(); const text = event.clipboardData?.getData('text/plain') || ''; const { start, end } = this.getSelection(); this.replaceRange(start, end, text);
    });
    container.addEventListener('compositionstart', () => { this.composing = true; });
    container.addEventListener('compositionend', () => { this.composing = false; this.#readMutation(); });
    container.addEventListener('input', () => { if (!this.composing) this.#readMutation(); });
    container.addEventListener('keydown', event => {
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) { event.preventDefault(); this.undo(); }
      else if (key === 'y' || (key === 'z' && event.shiftKey)) { event.preventDefault(); this.redo(); }
    });
    ['keyup', 'pointerup', 'focus'].forEach(type => container.addEventListener(type, () => this.onCursor?.()));
    container.addEventListener('click', event => {
      if (!getSelection()?.isCollapsed && getSelection()?.toString()) return;
      const wiki = event.target.closest('.live-wikilink');
      if (wiki) { event.preventDefault(); this.onLink?.(wiki.dataset.wikilink, wiki.dataset.heading || ''); return; }
      const link = event.target.closest('.live-markdown-link');
      if (link) { event.preventDefault(); this.onFileLink?.(link.dataset.href); return; }
      const tag = event.target.closest('.live-tag');
      if (tag) { event.preventDefault(); this.onTag?.(tag.dataset.tag); }
    });
  }

  setValue(source, resetHistory = true) {
    this.source = String(source ?? '').replace(/\r\n?/g, '\n'); this.render();
    if (resetHistory) { this.history = [{ source: this.source, start: 0, end: 0 }]; this.historyIndex = 0; }
  }
  value() { return this.source; }
  focus() { this.container.focus(); }
  isFocused() { return document.activeElement === this.container; }

  getSelection() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !this.container.contains(selection.anchorNode) || !this.container.contains(selection.focusNode)) return { start: this.source.length, end: this.source.length, text: '' };
    const offset = (node, position) => { const range = document.createRange(); range.selectNodeContents(this.container); range.setEnd(node, position); return range.toString().length; };
    const anchor = offset(selection.anchorNode, selection.anchorOffset), focus = offset(selection.focusNode, selection.focusOffset);
    const start = Math.min(anchor, focus), end = Math.max(anchor, focus); return { start, end, text: this.source.slice(start, end) };
  }

  setSelectionRange(start, end = start) {
    start = Math.max(0, Math.min(this.source.length, start)); end = Math.max(start, Math.min(this.source.length, end));
    const walker = document.createTreeWalker(this.container, NodeFilter.SHOW_TEXT); let node; let count = 0; let startNode = null, endNode = null, startOffset = 0, endOffset = 0;
    while ((node = walker.nextNode())) {
      const next = count + node.data.length;
      if (!startNode && start <= next) { startNode = node; startOffset = start - count; }
      if (!endNode && end <= next) { endNode = node; endOffset = end - count; break; }
      count = next;
    }
    if (!startNode) { startNode = this.container; startOffset = this.container.childNodes.length; }
    if (!endNode) { endNode = startNode; endOffset = startOffset; }
    const range = document.createRange(); range.setStart(startNode, startOffset); range.setEnd(endNode, endOffset);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }

  replaceRange(start, end, text, selectMode = 'end') {
    this.source = `${this.source.slice(0, start)}${text}${this.source.slice(end)}`;
    const selectionStart = selectMode === 'select' ? start : start + text.length, selectionEnd = selectMode === 'select' ? start + text.length : selectionStart;
    this.render(selectionStart, selectionEnd); this.#commitHistory(selectionStart, selectionEnd); this.onChange?.(this.source); this.onCursor?.();
  }

  undo() { this.#restoreHistory(this.historyIndex - 1); }
  redo() { this.#restoreHistory(this.historyIndex + 1); }

  render(selectionStart = null, selectionEnd = selectionStart) {
    this.rendering = true; this.container.innerHTML = '';
    const lines = this.source.split('\n');
    lines.forEach((line, index) => { this.container.append(decorateLine(line)); if (index < lines.length - 1) this.container.append(document.createTextNode('\n')); });
    if (!this.source) this.container.append(document.createElement('br'));
    this.rendering = false;
    if (selectionStart != null) { this.container.focus(); this.setSelectionRange(selectionStart, selectionEnd); }
  }

  #readMutation() {
    if (this.rendering) return;
    const selection = this.getSelection(); this.source = this.container.textContent.replace(/\r\n?/g, '\n');
    this.render(selection.start, selection.end); this.#commitHistory(selection.start, selection.end); this.onChange?.(this.source); this.onCursor?.();
  }

  #commitHistory(start, end) {
    const current = this.history[this.historyIndex];
    if (current?.source === this.source) { current.start = start; current.end = end; return; }
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push({ source: this.source, start, end });
    if (this.history.length > 200) this.history.shift();
    this.historyIndex = this.history.length - 1;
  }

  #restoreHistory(nextIndex) {
    if (nextIndex < 0 || nextIndex >= this.history.length || nextIndex === this.historyIndex) return;
    this.historyIndex = nextIndex; const snapshot = this.history[nextIndex]; this.source = snapshot.source;
    this.render(snapshot.start, snapshot.end); this.onChange?.(this.source); this.onCursor?.();
  }
}
