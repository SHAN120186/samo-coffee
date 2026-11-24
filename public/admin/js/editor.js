/* Samo Coffee admin — a small, dependable rich text editor.
   Progressive enhancement of <textarea data-editor-input>: a toolbar + contenteditable area that keeps the
   textarea in sync. The HTML is normalised here for convenience only; the server sanitises every value
   again (lib/sanitize.js), so nothing in this file is a security boundary. */
(function () {
  'use strict';

  const ICONS = {
    ul: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/></svg>',
    ol: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 4.5 5.5 4v5M4 14.5c.3-.7 2.5-.9 2.5.4 0 1-2.5 1.7-2.5 3.1h2.7" stroke-width="1.5"/></svg>',
    quote: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M5 17v-4.5C5 9.5 6.5 7.5 9.5 7v2c-1.3.4-2 1.3-2 2.5h2V17H5Zm8 0v-4.5c0-3 1.5-5 4.5-5.5v2c-1.3.4-2 1.3-2 2.5h2V17H13Z"/></svg>',
    link: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
    unlink: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 6.3 14 5.3A4 4 0 0 1 19.7 11l-1 1M11 17.7l-1 1A4 4 0 0 1 4.3 13l1-1M4 4l16 16"/></svg>',
    image: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m4 17 5-4.5 3.5 3 3-2.5 5 4"/></svg>',
    upload: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5M7.5 9 12 4.5 16.5 9M5 19.5h14"/></svg>',
    hr: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 12h16"/></svg>',
    clear: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 5h12M12 5v9M8 19h4M15 15l5 5M20 15l-5 5"/></svg>',
    undo: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5 4 9l4 4"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
    redo: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 5 4 4-4 4"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg>',
    code: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 7-5 5 5 5M16 7l5 5-5 5"/></svg>',
  };

  const BUTTONS = [
    { id: 'p', label: 'Абзац', text: '¶', block: 'p' },
    { id: 'h2', label: 'Заголовок', text: 'H2', block: 'h2' },
    { id: 'h3', label: 'Подзаголовок', text: 'H3', block: 'h3' },
    'sep',
    { id: 'bold', label: 'Полужирный (Ctrl+B)', text: 'Ж', cmd: 'bold' },
    { id: 'italic', label: 'Курсив (Ctrl+I)', text: 'К', cmd: 'italic', style: 'font-style:italic' },
    { id: 'underline', label: 'Подчёркнутый (Ctrl+U)', text: 'Ч', cmd: 'underline', style: 'text-decoration:underline' },
    { id: 'strike', label: 'Зачёркнутый', text: 'З', cmd: 'strikeThrough', style: 'text-decoration:line-through' },
    'sep',
    { id: 'ul', label: 'Маркированный список', icon: 'ul', cmd: 'insertUnorderedList' },
    { id: 'ol', label: 'Нумерованный список', icon: 'ol', cmd: 'insertOrderedList' },
    { id: 'quote', label: 'Цитата', icon: 'quote', block: 'blockquote' },
    'sep',
    { id: 'link', label: 'Ссылка', icon: 'link', action: 'link' },
    { id: 'unlink', label: 'Убрать ссылку', icon: 'unlink', cmd: 'unlink' },
    { id: 'image', label: 'Изображение из медиатеки', icon: 'image', action: 'image' },
    { id: 'upload', label: 'Загрузить изображение', icon: 'upload', action: 'upload' },
    { id: 'hr', label: 'Разделитель', icon: 'hr', cmd: 'insertHorizontalRule' },
    'sep',
    { id: 'clear', label: 'Очистить форматирование', icon: 'clear', action: 'clear' },
    { id: 'undo', label: 'Отменить (Ctrl+Z)', icon: 'undo', cmd: 'undo' },
    { id: 'redo', label: 'Повторить (Ctrl+Y)', icon: 'redo', cmd: 'redo' },
    'sep',
    { id: 'source', label: 'HTML-код', icon: 'code', action: 'source' },
  ];

  const BLOCKS = new Set(['P', 'H2', 'H3', 'H4', 'UL', 'OL', 'BLOCKQUOTE', 'HR', 'PRE', 'FIGURE', 'TABLE']);
  const KEEP_ATTRS = { A: ['href', 'title'], IMG: ['src', 'alt', 'title', 'width', 'height'] };
  const RENAME = { DIV: 'p', STRIKE: 's', DEL: 's', H1: 'h2', H5: 'h4', H6: 'h4' };
  const UNWRAP = new Set(['SPAN', 'FONT', 'SECTION', 'ARTICLE', 'O:P', 'CENTER', 'SMALL', 'BIG']);
  const DROP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'SVG']);

  /** Normalise the editable DOM into tidy HTML (paragraphs instead of divs, no inline styles). */
  function cleanHtml(root) {
    const box = root.cloneNode(true);
    const walk = (node) => {
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === 8) return child.remove();
        if (child.nodeType !== 1) return undefined;
        const tag = child.tagName.toUpperCase(); // SVG / MathML elements report lower-case names
        if (DROP.has(tag) || child.namespaceURI !== 'http://www.w3.org/1999/xhtml') return child.remove();
        walk(child);
        if (UNWRAP.has(tag)) {
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          return child.remove();
        }
        let el = child;
        if (RENAME[tag]) {
          el = document.createElement(RENAME[tag]);
          while (child.firstChild) el.appendChild(child.firstChild);
          node.replaceChild(el, child);
        }
        const keep = KEEP_ATTRS[el.tagName] || [];
        Array.from(el.attributes).forEach((attr) => {
          if (!keep.includes(attr.name)) el.removeAttribute(attr.name);
        });
        if (el.tagName === 'A' && el.hasAttribute('href') && !isSafeUrl(el.getAttribute('href').trim())) el.removeAttribute('href');
        if (el.tagName === 'IMG' && !/^(https?:\/\/|\/(?!\/))/i.test((el.getAttribute('src') || '').trim())) return el.remove();
        return undefined;
      });
    };
    walk(box);
    // top-level text / inline nodes become paragraphs
    let run = null;
    Array.from(box.childNodes).forEach((child) => {
      const isBlock = child.nodeType === 1 && BLOCKS.has(child.tagName);
      if (isBlock) {
        run = null;
        return;
      }
      if (child.nodeType === 3 && !child.nodeValue.trim() && !run) return child.remove();
      if (!run) {
        run = document.createElement('p');
        box.insertBefore(run, child);
      }
      run.appendChild(child);
      return undefined;
    });
    // Browsers nest lists / headings / paragraphs inside <p> (invalid HTML): lift them out and keep
    // the inline runs around them as separate paragraphs.
    let guard = 0;
    for (let p = findNestedBlock(box); p && guard < 200; p = findNestedBlock(box), guard += 1) {
      const fragment = document.createDocumentFragment();
      let inline = null;
      Array.from(p.childNodes).forEach((child) => {
        if (child.nodeType === 1 && BLOCKS.has(child.tagName)) {
          inline = null;
          fragment.appendChild(child);
        } else {
          if (!inline) {
            inline = document.createElement('p');
            fragment.appendChild(inline);
          }
          inline.appendChild(child);
        }
      });
      p.parentNode.replaceChild(fragment, p);
    }
    Array.from(box.querySelectorAll('p, h2, h3, h4, li, blockquote')).forEach((el) => {
      const empty = !el.textContent.trim() && !el.querySelector('img');
      if (empty && el.tagName !== 'LI') el.remove();
    });
    return box.innerHTML.replace(/​/g, '').replace(/&nbsp;/g, ' ').trim();
  }

  /**
   * HTML that is safe to put into the editable area: parsed inside an inert <template> (no script
   * runs, no image loads) and passed through the same cleaner. Stored values are already sanitized
   * by the server; this covers values echoed back after a failed validation.
   */
  function safeHtml(html) {
    const tpl = document.createElement('template');
    // Dropping on*="" attributes up front only avoids CSP console noise; the cleaner below removes them anyway.
    const quiet = String(html || '').replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, '');
    tpl.innerHTML = '<div>' + quiet + '</div>';
    return cleanHtml(tpl.content.firstChild);
  }

  /** First <p> that directly contains a block-level element, or null. */
  function findNestedBlock(box) {
    return Array.from(box.querySelectorAll('p')).find((p) => Array.from(p.children).some((c) => BLOCKS.has(c.tagName))) || null;
  }

  function isSafeUrl(url) {
    return /^(https?:\/\/|\/(?!\/)|mailto:|tel:|#)/i.test(url);
  }

  function enhance(wrapper) {
    const textarea = wrapper.querySelector('[data-editor-input]');
    if (!textarea || wrapper.dataset.ready) return;
    wrapper.dataset.ready = '1';

    const bar = document.createElement('div');
    bar.className = 'editor__bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Форматирование');
    const area = document.createElement('div');
    area.className = 'editor__area prose';
    area.contentEditable = 'true';
    area.setAttribute('role', 'textbox');
    area.setAttribute('aria-multiline', 'true');
    area.dataset.placeholder = textarea.dataset.placeholder || '';
    const label = textarea.id ? document.querySelector('label[for="' + textarea.id + '"]') : null;
    if (label) {
      area.setAttribute('aria-label', label.textContent.trim());
      label.addEventListener('click', (e) => {
        e.preventDefault();
        area.focus();
      });
    }
    area.innerHTML = safeHtml(textarea.value);
    const foot = document.createElement('div');
    foot.className = 'editor__foot';
    const counter = document.createElement('span');
    const hint = document.createElement('span');
    hint.textContent = 'Текст очищается от лишней разметки при сохранении';
    foot.append(hint, counter);

    const buttons = {};
    BUTTONS.forEach((def) => {
      if (def === 'sep') {
        const sep = document.createElement('span');
        sep.className = 'sep';
        bar.appendChild(sep);
        return;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.title = def.label;
      btn.setAttribute('aria-label', def.label);
      btn.dataset.id = def.id;
      if (def.icon) btn.innerHTML = ICONS[def.icon];
      else btn.textContent = def.text;
      if (def.style) btn.style.cssText = def.style;
      // keep the selection inside the editor when a toolbar button is pressed
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => run(def));
      buttons[def.id] = btn;
      bar.appendChild(btn);
    });

    textarea.classList.remove('textarea', 'editor__fallback');
    textarea.classList.add('editor__source');
    textarea.hidden = true;
    textarea.setAttribute('aria-label', 'HTML-код');
    wrapper.prepend(bar);
    wrapper.insertBefore(area, textarea);
    wrapper.appendChild(foot);

    let sourceMode = false;
    const exec = (cmd, value) => {
      area.focus();
      document.execCommand(cmd, false, value);
    };
    const sync = () => {
      if (!sourceMode) textarea.value = cleanHtml(area);
      const words = (area.textContent.trim().match(/\S+/g) || []).length;
      counter.textContent = words + ' ' + plural(words, ['слово', 'слова', 'слов']);
    };
    const refresh = () => {
      if (sourceMode) return;
      ['bold', 'italic', 'underline'].forEach((id) => buttons[id].setAttribute('aria-pressed', String(document.queryCommandState(id))));
      buttons.strike.setAttribute('aria-pressed', String(document.queryCommandState('strikeThrough')));
      buttons.ul.setAttribute('aria-pressed', String(document.queryCommandState('insertUnorderedList')));
      buttons.ol.setAttribute('aria-pressed', String(document.queryCommandState('insertOrderedList')));
      const block = String(document.queryCommandValue('formatBlock') || '').toLowerCase().replace(/[<>]/g, '');
      ['p', 'h2', 'h3'].forEach((id) => buttons[id].setAttribute('aria-pressed', String(block === id)));
      buttons.quote.setAttribute('aria-pressed', String(block === 'blockquote'));
    };

    function insertImage(url) {
      if (!url) return;
      area.focus();
      const alt = '';
      document.execCommand('insertHTML', false, '<img src="' + url.replace(/"/g, '&quot;') + '" alt="' + alt + '">');
      sync();
    }

    async function run(def) {
      if (sourceMode && def.action !== 'source') return;
      if (def.block) {
        const current = String(document.queryCommandValue('formatBlock') || '').toLowerCase().replace(/[<>]/g, '');
        exec('formatBlock', '<' + (current === def.block && def.block !== 'p' ? 'p' : def.block) + '>');
      } else if (def.cmd) {
        exec(def.cmd);
      } else if (def.action === 'link') {
        const selection = window.getSelection();
        const anchor = selection.anchorNode && selection.anchorNode.parentElement ? selection.anchorNode.parentElement.closest('a') : null;
        const url = window.prompt('Адрес ссылки (https://… или /catalog)', anchor ? anchor.getAttribute('href') : 'https://');
        if (url === null) return;
        const href = url.trim();
        if (!href) exec('unlink');
        else if (!isSafeUrl(href)) window.alert('Ссылка должна начинаться с https://, / , mailto: или tel:');
        else if (selection.isCollapsed && !anchor) exec('insertHTML', '<a href="' + href.replace(/"/g, '&quot;') + '">' + href.replace(/</g, '&lt;') + '</a>');
        else exec('createLink', href);
      } else if (def.action === 'image') {
        const range = saveRange();
        const url = await window.SamoAdmin.pickImage();
        restoreRange(range);
        insertImage(url);
      } else if (def.action === 'upload') {
        const range = saveRange();
        const files = await window.SamoAdmin.chooseFiles(false);
        if (!files.length) return;
        try {
          const items = await window.SamoAdmin.uploadImages(files);
          restoreRange(range);
          if (items[0]) insertImage(items[0].url);
        } catch (err) {
          window.SamoAdmin.toast(err.message, 'error');
        }
      } else if (def.action === 'clear') {
        exec('removeFormat');
        exec('formatBlock', '<p>');
      } else if (def.action === 'source') {
        sourceMode = !sourceMode;
        if (sourceMode) {
          textarea.value = cleanHtml(area);
        } else {
          area.innerHTML = safeHtml(textarea.value);
        }
        textarea.hidden = !sourceMode;
        area.hidden = sourceMode;
        buttons.source.setAttribute('aria-pressed', String(sourceMode));
        Object.keys(buttons).forEach((id) => {
          if (id !== 'source') buttons[id].disabled = sourceMode;
        });
        (sourceMode ? textarea : area).focus();
      }
      sync();
      refresh();
    }

    function saveRange() {
      const sel = window.getSelection();
      return sel.rangeCount && area.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    }
    function restoreRange(range) {
      area.focus();
      if (!range) return;
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    area.addEventListener('focus', () => {
      try {
        document.execCommand('defaultParagraphSeparator', false, 'p');
        document.execCommand('styleWithCSS', false, false);
      } catch (e) { /* older engines */ }
    });
    area.addEventListener('input', () => {
      sync();
      wrapper.dispatchEvent(new Event('input', { bubbles: true }));
    });
    ['keyup', 'mouseup', 'focus'].forEach((type) => area.addEventListener(type, refresh));
    // Paste as plain text: keeps the copy clean whatever the source (Word, Google Docs, web pages).
    area.addEventListener('paste', (event) => {
      const data = event.clipboardData;
      if (!data) return;
      const files = Array.from(data.files || []).filter((f) => /^image\//.test(f.type));
      if (files.length) {
        event.preventDefault();
        const range = saveRange();
        window.SamoAdmin.uploadImages([files[0]]).then((items) => {
          restoreRange(range);
          if (items[0]) insertImage(items[0].url);
        }, (err) => window.SamoAdmin.toast(err.message, 'error'));
        return;
      }
      event.preventDefault();
      document.execCommand('insertText', false, data.getData('text/plain'));
    });
    area.addEventListener('drop', (event) => {
      const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []).filter((f) => /^image\//.test(f.type));
      if (!files.length) return;
      event.preventDefault();
      window.SamoAdmin.uploadImages([files[0]]).then((items) => {
        if (items[0]) insertImage(items[0].url);
      }, (err) => window.SamoAdmin.toast(err.message, 'error'));
    });
    textarea.addEventListener('input', () => wrapper.dispatchEvent(new Event('change', { bubbles: true })));
    if (textarea.form) {
      textarea.form.addEventListener('submit', () => {
        if (!sourceMode) textarea.value = cleanHtml(area);
      });
    }
    sync();
  }

  function plural(n, forms) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }

  document.querySelectorAll('[data-editor]').forEach(enhance);
  window.SamoEditor = { enhance, cleanHtml, safeHtml };
})();
