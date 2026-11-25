// Home: brand header, search, banner, category chips, featured row, product grid.
import { tg } from '../tg.js';
import { store, loadProducts, loadMoreProducts, peekProducts } from '../store.js';
import { html, setHTML, icon, productCard, productGridSkeleton, priceBlock } from '../ui.js';
import { quickAdd } from '../actions.js';

const SORTS = [
  ['', 'По умолчанию'],
  ['popular', 'Сначала популярные'],
  ['new', 'Сначала новинки'],
  ['price_asc', 'Сначала дешевле'],
  ['price_desc', 'Сначала дороже'],
];

/** Filters survive navigation (product → back keeps the chip and the query). */
const state = { category: '', search: '', sort: '' };

const listParams = () => ({ category: state.category, search: state.search, sort: state.sort });

function featuredCard(p) {
  return html`
    <a class="fcard" href="#/product/${p.id}">
      <span class="fcard__media"><img src="${p.image}" alt="" loading="lazy" decoding="async" width="200" height="200"></span>
      <span>
        <span class="fcard__title">${p.title}</span>
        <span class="fcard__sub">${p.subtitle || p.category_title}</span>
        <span class="fcard__foot">${priceBlock(p)}<button class="add-btn" type="button" data-add="${p.id}" aria-label="Добавить в корзину: ${p.title}" ${p.in_stock ? '' : 'disabled'}>${icon('plus', { stroke: 2.4 })}</button></span>
      </span>
    </a>`;
}

export default {
  tab: 'home',
  root: true,
  title: 'Каталог',

  async mount(ctx) {
    const { boot } = store;
    const t = boot.texts || {};
    const name = boot.user.first_name || '';
    // shop name from Admin → Настройки: the first word is plain, the rest is set in the accent italic
    const [brandFirst, ...brandWords] = String(boot.settings.site_name || 'Samo Coffee').trim().split(/\s+/);
    const brandRest = brandWords.join(' ');

    setHTML(ctx.el, html`
      <div class="screen screen--home">
        <header class="hello">
          <div class="brand">
            <img class="brand__mark" src="/img/favicon.svg" alt="" width="40" height="40">
            <div style="min-width:0">
              <div class="brand__name">${brandFirst} <em>${brandRest}</em></div>
              <div class="brand__sub">${name ? `Привет, ${name}!` : boot.settings.site_tagline}</div>
            </div>
          </div>
          ${boot.dev ? html`<span class="demo-pill" title="Предпросмотр в браузере без Telegram">Демо-режим</span>` : ''}
        </header>

        <label class="search">
          ${icon('search')}
          <input type="search" id="search" inputmode="search" enterkeyhint="search" autocomplete="off" placeholder="Найти кофе, дрипы, аксессуары" value="${state.search}" aria-label="Поиск по каталогу">
          <button class="search__clear" id="search-clear" type="button" aria-label="Очистить" ${state.search ? '' : 'hidden'}>${icon('x', { size: 18 })}</button>
        </label>

        <section class="hero" id="hero">
          ${t.banner_image ? html`<img src="${t.banner_image}" alt="" decoding="async">` : ''}
          <span class="hero__eyebrow">${brandFirst} · Ташкент</span>
          <h1 class="hero__title">${t.home_title || 'Свежая обжарка недели'}</h1>
          <p class="hero__text">${t.home_text || ''}</p>
          <button class="hero__cta" type="button" id="hero-cta">Выбрать кофе ${icon('arrow', { size: 14, stroke: 2.2 })}</button>
        </section>

        <div class="chips" id="chips" role="tablist" aria-label="Категории">
          <button class="chip ${state.category ? '' : 'is-active'}" type="button" role="tab" data-category="">Все</button>
          ${boot.categories.map((c) => html`<button class="chip ${state.category === c.slug ? 'is-active' : ''}" type="button" role="tab" data-category="${c.slug}">${c.title}</button>`)}
        </div>

        <section id="featured" hidden>
          <div class="section-head"><h2>Выбор обжарщика</h2></div>
          <div class="hscroll" id="featured-list"></div>
        </section>

        <section id="catalog">
          <div class="section-head">
            <h2 id="catalog-title">Каталог</h2>
            <select class="sort" id="sort" aria-label="Сортировка">
              ${SORTS.map(([value, label]) => html`<option value="${value}" ${state.sort === value ? 'selected' : ''}>${label}</option>`)}
            </select>
          </div>
          <div class="grid2" id="grid">${productGridSkeleton(6)}</div>
          <div class="grid-more" id="more" hidden></div>
        </section>
      </div>`);

    const $ = (selector) => ctx.el.querySelector(selector);
    const grid = $('#grid');
    let request = 0;

    const renderGrid = (data) => {
      const category = boot.categories.find((c) => c.slug === state.category);
      $('#catalog-title').textContent = state.search ? 'Результаты' : category ? category.title : 'Каталог';
      if (!data.items.length) {
        $('#more').hidden = true;
        grid.style.display = 'block';
        setHTML(grid, html`<div class="empty"><b>Ничего не нашли</b>${state.search ? 'Попробуйте другой запрос или посмотрите весь каталог.' : 'В этой категории пока пусто — загляните позже.'}</div>`);
        return;
      }
      grid.style.display = '';
      setHTML(grid, html`${data.items.map(productCard)}`);
      renderMore(data);
    };

    // The API gives 60 products per request: the rest of a long list is loaded page by page —
    // by the button, and by itself when the button scrolls into view.
    let moreObserver = null;
    const loadMore = async () => {
      const mine = request;
      const button = $('#grid-more');
      if (!button || button.disabled) return;
      button.disabled = true;
      button.textContent = 'Загружаем…';
      try {
        const data = await loadMoreProducts(listParams());
        if (ctx.alive && mine === request) renderGrid(data);
      } catch (err) {
        if (!ctx.alive || mine !== request) return;
        button.disabled = false;
        button.textContent = 'Не получилось — повторить';
      }
    };
    const renderMore = (data) => {
      if (moreObserver) moreObserver.disconnect();
      const more = $('#more');
      const left = data.total - data.items.length;
      more.hidden = left <= 0;
      if (left <= 0) return setHTML(more, '');
      setHTML(more, html`<button class="btn btn--soft" type="button" id="grid-more">Показать ещё · осталось ${left}</button>`);
      $('#grid-more').addEventListener('click', loadMore);
      if ('IntersectionObserver' in window) {
        moreObserver = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) loadMore();
        }, { rootMargin: '300px' });
        moreObserver.observe($('#grid-more'));
      }
      return null;
    };
    ctx.onCleanup(() => moreObserver && moreObserver.disconnect());

    const loadGrid = async () => {
      const mine = ++request;
      const cached = peekProducts(listParams());
      if (cached) return renderGrid(cached);
      grid.style.display = '';
      $('#more').hidden = true;
      setHTML(grid, productGridSkeleton(4));
      try {
        const data = await loadProducts(listParams());
        if (ctx.alive && mine === request) renderGrid(data);
      } catch (err) {
        if (!ctx.alive || mine !== request) return;
        grid.style.display = 'block';
        setHTML(grid, html`<div class="empty"><b>Не получилось загрузить</b>${err.message}<div style="margin-top:12px"><button class="btn btn--soft btn--sm" type="button" id="grid-retry">Повторить</button></div></div>`);
        $('#grid-retry').addEventListener('click', loadGrid);
      }
      return null;
    };

    const syncFeatured = async () => {
      const section = $('#featured');
      const visible = !state.category && !state.search;
      $('#hero').hidden = Boolean(state.search);
      if (!visible) {
        section.hidden = true;
        return;
      }
      try {
        const data = await loadProducts({ featured: true, limit: 8 });
        if (!ctx.alive || state.category || state.search) return;
        if (data.items.length) {
          setHTML($('#featured-list'), html`${data.items.map(featuredCard)}`);
          section.hidden = false;
        }
      } catch { /* the grid shows the error */ }
    };

    $('#chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip || chip.classList.contains('is-active')) return;
      tg.haptic('select');
      state.category = chip.dataset.category;
      $('#chips').querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      chip.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      syncFeatured();
      loadGrid();
    });

    let searchTimer = null;
    const input = $('#search');
    const applySearch = () => {
      const value = input.value.trim().slice(0, 80);
      $('#search-clear').hidden = !input.value;
      if (value === state.search) return;
      state.search = value;
      syncFeatured();
      loadGrid();
    };
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(applySearch, 280);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(searchTimer);
        applySearch();
        input.blur();
      }
    });
    $('#search-clear').addEventListener('click', () => {
      input.value = '';
      clearTimeout(searchTimer);
      applySearch();
    });
    ctx.onCleanup(() => clearTimeout(searchTimer));

    $('#sort').addEventListener('change', (e) => {
      state.sort = e.target.value;
      tg.haptic('select');
      loadGrid();
    });

    $('#hero-cta').addEventListener('click', () => {
      tg.haptic('light');
      $('#chips').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    ctx.el.querySelector('.screen').addEventListener('click', (e) => {
      const add = e.target.closest('[data-add]');
      if (!add) return;
      e.preventDefault();
      e.stopPropagation();
      quickAdd(add);
    });

    await Promise.all([syncFeatured(), loadGrid()]);
  },
};
