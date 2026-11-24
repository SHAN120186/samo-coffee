/* Samo Coffee admin — small vanilla helpers shared by every page of the panel.
   No inline scripts (CSP): behaviour is attached through data-* attributes. */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const csrf = () => ($('meta[name="csrf-token"]') || {}).content || '';

  // ───────────────────────────── toasts
  function toast(message, type) {
    const box = $('.toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' toast--error' : '');
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 6000 : 2600);
  }

  // ───────────────────────────── fetch helpers
  async function postJson(url, data) {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf(), 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(data || {}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error(body.message || 'Не удалось выполнить действие');
    return body;
  }

  async function uploadImages(fileList) {
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return [];
    const form = new FormData();
    files.slice(0, 10).forEach((f) => form.append('files', f));
    const res = await fetch('/admin/media/upload', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrf(), 'X-Requested-With': 'XMLHttpRequest' },
      body: form,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.message || 'Не удалось загрузить файл');
    (body.warnings || []).forEach((w) => toast(w, 'error'));
    return body.items || [];
  }

  function chooseFiles(multiple) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png,image/webp,image/gif,image/avif';
      input.multiple = Boolean(multiple);
      input.addEventListener('change', () => resolve(Array.from(input.files || [])));
      input.click();
    });
  }

  // ───────────────────────────── confirm dialog
  const confirmDialog = $('#confirm-dialog');
  function askConfirm(text, okLabel, tone) {
    if (!confirmDialog || typeof confirmDialog.showModal !== 'function') return Promise.resolve(window.confirm(text));
    $('[data-confirm-text]', confirmDialog).textContent = text;
    const ok = $('[data-confirm-ok]', confirmDialog);
    ok.textContent = okLabel || 'Удалить';
    ok.className = 'btn ' + (tone === 'primary' ? 'btn--primary' : 'btn--danger');
    return new Promise((resolve) => {
      confirmDialog.returnValue = 'cancel';
      confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'ok'), { once: true });
      confirmDialog.showModal();
    });
  }

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const submitter = event.submitter;
    const text = (submitter && submitter.dataset.confirm) || form.dataset.confirm;
    if (!text || form.dataset.confirmed === '1') return;
    event.preventDefault();
    const okLabel = (submitter && submitter.dataset.confirmOk) || form.dataset.confirmOk;
    const tone = (submitter && submitter.dataset.confirmTone) || form.dataset.confirmTone;
    askConfirm(text, okLabel, tone).then((yes) => {
      if (!yes) return;
      form.dataset.confirmed = '1';
      if (form.requestSubmit) form.requestSubmit(submitter || undefined);
      else form.submit();
    });
  });

  // ───────────────────────────── sidebar (small screens)
  const sidebar = $('#adm-sidebar');
  $$('[data-sidebar-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const open = sidebar.classList.toggle('is-open');
      btn.setAttribute('aria-expanded', String(open));
    });
  });
  document.addEventListener('click', (event) => {
    if (sidebar && sidebar.classList.contains('is-open') && !event.target.closest('#adm-sidebar, [data-sidebar-toggle]')) {
      sidebar.classList.remove('is-open');
    }
  });

  // ───────────────────────────── media picker dialog
  const picker = $('#media-picker');
  function pickImage() {
    if (!picker || typeof picker.showModal !== 'function') return Promise.resolve(null);
    const grid = $('[data-picker-grid]', picker);
    grid.textContent = 'Загрузка…';
    return new Promise((resolve) => {
      let chosen = null;
      const onClose = () => resolve(chosen);
      picker.addEventListener('close', onClose, { once: true });
      fetch('/admin/media/list.json', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then((r) => r.json())
        .then((body) => {
          grid.textContent = '';
          const items = (body && body.items) || [];
          if (!items.length) {
            const p = document.createElement('p');
            p.className = 'help';
            p.textContent = 'В медиатеке пока пусто. Закройте окно и нажмите «Загрузить», чтобы добавить изображение с компьютера.';
            grid.appendChild(p);
            return;
          }
          items.forEach((item) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'picker__item';
            btn.title = item.name || '';
            const img = document.createElement('img');
            img.src = item.url;
            img.alt = item.alt || item.name || '';
            img.loading = 'lazy';
            btn.appendChild(img);
            btn.addEventListener('click', () => {
              chosen = item.url;
              picker.close();
            });
            grid.appendChild(btn);
          });
        })
        .catch(() => {
          grid.textContent = 'Не удалось загрузить список изображений.';
        });
      picker.showModal();
    });
  }
  if (picker) {
    $$('[data-picker-close]', picker).forEach((b) => b.addEventListener('click', () => picker.close()));
    picker.addEventListener('click', (e) => {
      if (e.target === picker) picker.close();
    });
  }

  // ───────────────────────────── single image fields
  function setPreview(box, url) {
    box.textContent = '';
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      box.appendChild(img);
    }
  }
  $$('[data-image-field]').forEach((field) => {
    const input = $('[data-image-input]', field);
    const preview = $('[data-image-preview]', field);
    const status = $('[data-image-status]', field);
    const say = (text, isError) => {
      status.textContent = text || '';
      status.classList.toggle('is-error', Boolean(isError));
    };
    const set = (url) => {
      input.value = url;
      setPreview(preview, url);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    input.addEventListener('change', () => setPreview(preview, input.value.trim()));
    $('[data-image-clear]', field).addEventListener('click', () => {
      set('');
      say('');
    });
    $('[data-image-pick]', field).addEventListener('click', async () => {
      const url = await pickImage();
      if (url) set(url);
    });
    const upload = async (files) => {
      if (!files.length) return;
      say('Загружаем…');
      try {
        const items = await uploadImages([files[0]]);
        if (items[0]) set(items[0].url);
        say('Загружено');
      } catch (err) {
        say(err.message, true);
      }
    };
    $('[data-image-upload]', field).addEventListener('click', async () => upload(await chooseFiles(false)));
    field.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    field.addEventListener('drop', (e) => {
      e.preventDefault();
      upload(Array.from(e.dataTransfer.files || []));
    });
  });

  // ───────────────────────────── product gallery (ordered list of images)
  $$('[data-gallery]').forEach((root) => {
    const list = $('[data-gallery-list]', root);
    const template = $('template', root);
    const name = root.dataset.name || 'images[]';
    const status = $('[data-gallery-status]', root);
    const max = Number(root.dataset.max) || 12;
    const say = (text, isError) => {
      if (!status) return;
      status.textContent = text || '';
      status.classList.toggle('is-error', Boolean(isError));
    };
    const count = () => $$('[data-gallery-item]', list).length;
    function add(url) {
      if (!url || count() >= max) return;
      const node = template.content.firstElementChild.cloneNode(true);
      $('img', node).src = url;
      const hidden = $('input[type="hidden"]', node);
      hidden.name = name;
      hidden.value = url;
      list.appendChild(node);
      root.dispatchEvent(new Event('input', { bubbles: true }));
    }
    list.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-act]');
      if (!btn) return;
      const item = btn.closest('[data-gallery-item]');
      if (btn.dataset.act === 'remove') item.remove();
      if (btn.dataset.act === 'left' && item.previousElementSibling) list.insertBefore(item, item.previousElementSibling);
      if (btn.dataset.act === 'right' && item.nextElementSibling) list.insertBefore(item.nextElementSibling, item);
      root.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // drag to reorder
    let dragged = null;
    list.addEventListener('dragstart', (e) => {
      dragged = e.target.closest('[data-gallery-item]');
      if (dragged) e.dataTransfer.effectAllowed = 'move';
    });
    list.addEventListener('dragover', (e) => {
      const over = e.target.closest('[data-gallery-item]');
      if (!dragged || !over || over === dragged) return;
      e.preventDefault();
      const rect = over.getBoundingClientRect();
      list.insertBefore(dragged, e.clientX < rect.left + rect.width / 2 ? over : over.nextElementSibling);
    });
    list.addEventListener('dragend', () => {
      dragged = null;
      root.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const upload = async (files) => {
      const images = files.filter((f) => /^image\//.test(f.type));
      if (!images.length) return;
      say('Загружаем…');
      try {
        const items = await uploadImages(images);
        items.forEach((item) => add(item.url));
        say(items.length > 1 ? 'Загружено: ' + items.length : 'Загружено');
      } catch (err) {
        say(err.message, true);
      }
    };
    $$('[data-gallery-upload]', root).forEach((b) => b.addEventListener('click', async () => upload(await chooseFiles(true))));
    $$('[data-gallery-pick]', root).forEach((b) => b.addEventListener('click', async () => add(await pickImage())));
    root.addEventListener('dragover', (e) => {
      if (dragged) return;
      e.preventDefault();
      root.classList.add('is-dragover');
    });
    root.addEventListener('dragleave', () => root.classList.remove('is-dragover'));
    root.addEventListener('drop', (e) => {
      root.classList.remove('is-dragover');
      if (dragged) return;
      e.preventDefault();
      upload(Array.from(e.dataTransfer.files || []));
    });
  });

  // ───────────────────────────── key/value rows (product attributes)
  $$('[data-kv]').forEach((root) => {
    const rows = $('[data-kv-rows]', root);
    const template = $('template', root);
    $('[data-kv-add]', root).addEventListener('click', () => {
      const node = template.content.firstElementChild.cloneNode(true);
      rows.appendChild(node);
      const first = $('input', node);
      if (first) first.focus();
    });
    rows.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-kv-remove]');
      if (btn) btn.closest('[data-kv-row]').remove();
    });
  });

  // ───────────────────────────── copy to clipboard
  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-copy]');
    if (!btn) return;
    const text = btn.dataset.copy;
    const done = () => toast('Скопировано: ' + text);
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => toast('Не удалось скопировать', 'error'));
    } else {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand('copy');
        done();
      } catch (e) {
        toast('Не удалось скопировать', 'error');
      }
      area.remove();
    }
  });

  // ───────────────────────────── sortable tables (FAQ, categories, plans)
  $$('[data-reorder-url]').forEach((table) => {
    const body = table.tBodies[0];
    if (!body) return;
    let dragged = null;
    const save = () => {
      const ids = $$('tr[data-id]', body).map((tr) => tr.dataset.id);
      postJson(table.dataset.reorderUrl, { ids }).then(
        () => toast('Порядок сохранён'),
        (err) => toast(err.message, 'error'),
      );
    };
    $$('.grip', body).forEach((grip) => {
      const row = grip.closest('tr');
      grip.addEventListener('mousedown', () => {
        row.draggable = true;
      });
      grip.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        if (e.key === 'ArrowUp' && row.previousElementSibling) body.insertBefore(row, row.previousElementSibling);
        if (e.key === 'ArrowDown' && row.nextElementSibling) body.insertBefore(row.nextElementSibling, row);
        grip.focus();
        save();
      });
    });
    body.addEventListener('dragstart', (e) => {
      dragged = e.target.closest('tr[data-id]');
      if (!dragged) return;
      dragged.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragged.dataset.id);
    });
    body.addEventListener('dragover', (e) => {
      const over = e.target.closest('tr[data-id]');
      if (!dragged || !over || over === dragged) return;
      e.preventDefault();
      const rect = over.getBoundingClientRect();
      body.insertBefore(dragged, e.clientY < rect.top + rect.height / 2 ? over : over.nextElementSibling);
    });
    body.addEventListener('drop', (e) => e.preventDefault());
    body.addEventListener('dragend', () => {
      if (!dragged) return;
      dragged.classList.remove('is-dragging');
      dragged.draggable = false;
      dragged = null;
      save();
    });
  });

  // ───────────────────────────── small conveniences
  $$('[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form && el.form.submit()));

  $$('[data-counter]').forEach((area) => {
    const out = document.getElementById(area.dataset.counter);
    if (!out) return;
    const update = () => {
      out.textContent = area.value.length + ' / ' + (area.maxLength > 0 ? area.maxLength : '∞');
    };
    area.addEventListener('input', update);
    update();
  });

  // Ctrl/⌘ + Enter submits the form of a textarea (reply box, notes).
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
    const area = event.target.closest && event.target.closest('textarea[data-submit-hotkey]');
    if (area && area.form) {
      event.preventDefault();
      if (area.form.requestSubmit) area.form.requestSubmit();
      else area.form.submit();
    }
  });

  // Chat: start at the newest message.
  $$('[data-scroll-bottom]').forEach((el) => {
    el.scrollTop = el.scrollHeight;
  });

  // Table-view twin of a chart.
  $$('[data-toggle-target]').forEach((btn) => {
    const target = document.getElementById(btn.dataset.toggleTarget);
    if (!target) return;
    btn.addEventListener('click', () => {
      target.hidden = !target.hidden;
      btn.setAttribute('aria-expanded', String(!target.hidden));
    });
  });

  // Media library: drag files onto the drop zone → upload → reload.
  $$('[data-dropzone]').forEach((zone) => {
    const input = $('input[type="file"]', zone);
    const form = zone.closest('form');
    ['dragenter', 'dragover'].forEach((type) => zone.addEventListener(type, (e) => {
      e.preventDefault();
      zone.classList.add('is-dragover');
    }));
    ['dragleave', 'drop'].forEach((type) => zone.addEventListener(type, () => zone.classList.remove('is-dragover')));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files || []);
      if (!files.length) return;
      uploadImages(files).then(
        () => window.location.reload(),
        (err) => toast(err.message, 'error'),
      );
    });
    if (input && form) input.addEventListener('change', () => input.files.length && form.submit());
  });

  // Broadcasts: live preview + progress polling while a broadcast is being sent.
  const composer = $('[data-broadcast-form]');
  if (composer) {
    const out = $('[data-broadcast-preview]');
    const allowed = /^(b|strong|i|em|u|s|a|code|pre|blockquote)$/i;
    const render = () => {
      const text = composer.elements.text.value;
      const image = composer.elements.image.value.trim();
      const btnText = composer.elements.button_text.value.trim();
      out.textContent = '';
      if (!text.trim() && !image) {
        const empty = document.createElement('p');
        empty.className = 'tg-empty';
        empty.textContent = 'Здесь появится предпросмотр сообщения.';
        out.appendChild(empty);
        return;
      }
      const bubble = document.createElement('div');
      bubble.className = 'tg-bubble';
      if (/^https:\/\//.test(image)) {
        const img = document.createElement('img');
        img.src = image;
        img.alt = '';
        bubble.appendChild(img);
      }
      // Render the Telegram HTML subset safely: a tiny tokenizer builds DOM nodes for the allowed
      // tags only; everything else stays literal text (nothing is ever parsed as HTML).
      const stack = [bubble];
      const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?)>/g;
      let last = 0;
      let m;
      const top = () => stack[stack.length - 1];
      while ((m = tagRe.exec(text)) !== null) {
        const name = m[2].toLowerCase();
        if (!allowed.test(name)) continue; // unknown tag → shown as typed
        if (m.index > last) top().appendChild(document.createTextNode(text.slice(last, m.index)));
        last = tagRe.lastIndex;
        if (m[1]) {
          if (stack.length > 1 && top().tagName.toLowerCase() === name) stack.pop();
        } else {
          const el = document.createElement(name);
          if (name === 'a') {
            const href = /href\s*=\s*"([^"]*)"/i.exec(m[3] || '');
            if (href && /^https?:\/\//i.test(href[1])) el.href = href[1];
            el.target = '_blank';
            el.rel = 'noopener';
          }
          top().appendChild(el);
          stack.push(el);
        }
      }
      if (last < text.length) top().appendChild(document.createTextNode(text.slice(last)));
      out.appendChild(bubble);
      if (btnText) {
        const b = document.createElement('span');
        b.className = 'tg-button';
        b.textContent = btnText;
        out.appendChild(b);
      }
    };
    composer.addEventListener('input', render);
    render();
  }
  const history = $('[data-broadcast-history]');
  if (history && history.dataset.sending === '1') {
    const timer = setInterval(() => {
      fetch('/admin/broadcasts/status.json', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then((r) => r.json())
        .then((body) => {
          let active = false;
          (body.items || []).forEach((item) => {
            const row = $('tr[data-id="' + item.id + '"]', history);
            if (!row) return;
            const bar = $('[data-progress]', row);
            const label = $('[data-progress-label]', row);
            const done = item.sent + item.failed;
            if (bar) bar.style.width = (item.total ? Math.round((done / item.total) * 100) : 0) + '%';
            if (label) label.textContent = item.sent + ' из ' + item.total + (item.failed ? ' · ошибок: ' + item.failed : '');
            if (item.status === 'sending') active = true;
          });
          if (!active) {
            clearInterval(timer);
            window.location.reload();
          }
        })
        .catch(() => {});
    }, 2000);
  }

  // Unsaved changes guard for long forms.
  $$('form[data-guard]').forEach((form) => {
    let dirty = false;
    form.addEventListener('input', () => {
      dirty = true;
    });
    form.addEventListener('submit', () => {
      dirty = false;
    });
    window.addEventListener('beforeunload', (e) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });
  });

  window.SamoAdmin = { toast, postJson, uploadImages, chooseFiles, pickImage, askConfirm };
})();
