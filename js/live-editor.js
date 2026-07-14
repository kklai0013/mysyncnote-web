function splitBlocks(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('```')) {
      const code = [lines[i]];
      while (++i < lines.length) { code.push(lines[i]); if (lines[i].startsWith('```')) break; }
      blocks.push({ source: code.join('\n') });
    } else blocks.push({ source: lines[i] });
  }
  return blocks.length ? blocks : [{ source: '' }];
}

function continuationPrefix(line) {
  const task = line.match(/^(\s*[-*+]\s+\[[ xX]\]\s+)/);
  if (task) return task[1].replace(/[xX]/, ' ');
  const bullet = line.match(/^(\s*[-*+]\s+)/);
  if (bullet) return bullet[1];
  const ordered = line.match(/^(\s*)(\d+)([.)]\s+)/);
  if (ordered) return `${ordered[1]}${Number(ordered[2]) + 1}${ordered[3]}`;
  const quote = line.match(/^(\s*>\s?)/);
  return quote?.[1] || '';
}

export class LiveMarkdownEditor {
  constructor(container, { renderBlock, onChange, onLink }) {
    this.container = container;
    this.renderBlock = renderBlock;
    this.onChange = onChange;
    this.onLink = onLink;
    this.blocks = [{ source: '' }];
    this.activeIndex = -1;
  }

  setValue(source) {
    this.blocks = splitBlocks(source);
    this.activeIndex = -1;
    this.render();
  }

  value() { return this.blocks.map(block => block.source).join('\n'); }
  activeTextarea() { return this.container.querySelector('.live-block-editor'); }

  render() {
    this.container.innerHTML = '';
    this.blocks.forEach((block, index) => {
      const element = document.createElement('div');
      element.className = `live-block${block.source ? '' : ' live-blank'}`;
      element.dataset.index = index;
      if (!block.source) element.innerHTML = '<span>點這裡開始新段落</span>';
      else element.innerHTML = this.renderBlock(block.source);
      element.addEventListener('pointerdown', event => {
        if (event.target.closest('[data-wikilink]')) return;
        event.preventDefault(); this.activate(index);
      });
      element.querySelectorAll('[data-wikilink]').forEach(link => link.addEventListener('click', event => { event.stopPropagation(); this.onLink?.(link.dataset.wikilink, link.dataset.heading || ''); }));
      this.container.append(element);
    });
  }

  activate(index, caret = null) {
    this.commit();
    this.activeIndex = index;
    const element = this.container.querySelector(`[data-index="${index}"]`);
    if (!element) return;
    const textarea = document.createElement('textarea');
    textarea.className = 'live-block-editor'; textarea.value = this.blocks[index].source; textarea.spellcheck = true;
    element.innerHTML = ''; element.append(textarea); element.classList.add('editing');
    const resize = () => { textarea.style.height = '1px'; textarea.style.height = `${Math.max(34, textarea.scrollHeight)}px`; };
    textarea.addEventListener('input', () => { this.blocks[index].source = textarea.value; resize(); this.onChange?.(this.value()); });
    textarea.addEventListener('blur', () => this.commit());
    textarea.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); textarea.blur(); return; }
      if (event.key === 'Enter' && !event.shiftKey && !textarea.value.includes('```')) {
        event.preventDefault();
        const start = textarea.selectionStart, before = textarea.value.slice(0, start), after = textarea.value.slice(textarea.selectionEnd);
        const prefix = continuationPrefix(before);
        this.blocks[index].source = before;
        this.blocks.splice(index + 1, 0, { source: prefix + after });
        this.onChange?.(this.value()); this.activeIndex = -1; this.render(); this.activate(index + 1, prefix.length); return;
      }
      if (event.key === 'Backspace' && textarea.selectionStart === 0 && textarea.selectionEnd === 0 && index > 0) {
        event.preventDefault();
        const previous = this.blocks[index - 1].source;
        this.blocks[index - 1].source += textarea.value;
        this.blocks.splice(index, 1); this.onChange?.(this.value()); this.activeIndex = -1; this.render(); this.activate(index - 1, previous.length);
      }
    });
    textarea.focus();
    const position = caret == null ? textarea.value.length : Math.min(caret, textarea.value.length);
    textarea.setSelectionRange(position, position); resize();
  }

  commit(render = true) {
    const textarea = this.activeTextarea();
    if (textarea && this.activeIndex >= 0) this.blocks[this.activeIndex].source = textarea.value;
    this.activeIndex = -1;
    if (render) this.render();
  }
}
