/* Samo Coffee admin — dashboard charts (Chart.js from /vendor, data from the JSON block in the page).
   Rules: one y-axis per chart, thin marks, recessive grid, one shared tooltip with every series. */
(function () {
  'use strict';
  const dataEl = document.getElementById('dashboard-data');
  if (!dataEl || !window.Chart) return;
  const data = JSON.parse(dataEl.textContent);
  const css = getComputedStyle(document.body);
  const token = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
  const C = {
    s1: token('--series-1', '#b84a24'),
    s2: token('--series-2', '#2b6ea6'),
    grid: token('--cream-200', '#efe5d3'),
    text: token('--color-text-muted', '#7a6657'),
    surface: token('--adm-surface', '#ffffff'),
  };
  const nf = new Intl.NumberFormat('ru-RU');
  const compact = (v) => {
    const n = Math.abs(v);
    if (n >= 1e6) return nf.format(Math.round(v / 1e5) / 10) + ' млн';
    if (n >= 1e4) return nf.format(Math.round(v / 1e3)) + ' тыс';
    return nf.format(v);
  };
  const money = (v) => nf.format(v) + ' сум';

  const Chart = window.Chart;
  Chart.defaults.font.family = token('--font-body', 'system-ui, sans-serif');
  Chart.defaults.font.size = 11;
  Chart.defaults.color = C.text;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) Chart.defaults.animation = false;
  else Chart.defaults.animation.duration = 350;

  // One tooltip element per page: values lead, series keyed by a short stroke.
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.setAttribute('role', 'status');
  document.body.appendChild(tip);
  function externalTooltip(format) {
    return ({ chart, tooltip }) => {
      if (!tooltip || tooltip.opacity === 0) {
        tip.style.opacity = '0';
        return;
      }
      tip.textContent = '';
      const title = document.createElement('div');
      title.className = 'chart-tip__title';
      title.textContent = (tooltip.title || []).join(' ');
      tip.appendChild(title);
      (tooltip.dataPoints || []).forEach((p) => {
        const row = document.createElement('div');
        row.className = 'chart-tip__row';
        row.style.setProperty('--key', p.dataset.borderColor || p.dataset.backgroundColor);
        const name = document.createElement('span');
        name.textContent = p.dataset.label;
        const value = document.createElement('b');
        value.textContent = format(p.parsed.y);
        row.append(name, value);
        tip.appendChild(row);
      });
      const rect = chart.canvas.getBoundingClientRect();
      const x = rect.left + window.scrollX + tooltip.caretX;
      const y = rect.top + window.scrollY + Math.min(tooltip.caretY, chart.chartArea.bottom - 20);
      tip.style.left = Math.max(90, Math.min(x, document.documentElement.clientWidth - 90)) + 'px';
      tip.style.top = y + 'px';
      tip.style.opacity = '1';
    };
  }

  // Vertical hairline at the hovered X — readers aim at a date, not at a 2px line.
  const crosshair = {
    id: 'crosshair',
    afterDatasetsDraw(chart) {
      const active = chart.tooltip && chart.tooltip.getActiveElements ? chart.tooltip.getActiveElements() : [];
      if (!active.length || chart.config.type !== 'line') return;
      const x = active[0].element.x;
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.lineWidth = 1;
      ctx.strokeStyle = token('--cream-400', '#cdbb9f');
      ctx.stroke();
      ctx.restore();
    },
  };

  const baseOptions = (format, tickFormat) => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 6, right: 4 } },
    plugins: {
      legend: { display: false },
      tooltip: { enabled: false, external: externalTooltip(format) },
    },
    scales: {
      x: {
        ...(data.labels.length === 1 ? { offset: true } : {}),
        grid: { display: false },
        border: { color: C.grid },
        ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 18, maxTicksLimit: data.weekly ? 7 : 10 },
      },
      y: {
        beginAtZero: true,
        border: { display: false },
        grid: { color: C.grid, lineWidth: 1, drawTicks: false },
        ticks: { padding: 8, maxTicksLimit: 5, precision: 0, callback: (v) => (tickFormat || compact)(v) },
      },
    },
  });

  const line = (label, values, color, fill) => ({
    label,
    data: values,
    borderColor: color,
    backgroundColor: fill ? color + '1a' : color,
    fill: Boolean(fill),
    borderWidth: 2,
    borderJoinStyle: 'round',
    borderCapStyle: 'round',
    tension: 0.25,
    pointRadius: values.length <= 1 ? 4 : 0,
    pointBackgroundColor: color,
    pointBorderColor: C.surface,
    pointBorderWidth: values.length <= 1 ? 2 : 0,
    pointHoverRadius: 4,
    pointHoverBackgroundColor: color,
    pointHoverBorderColor: C.surface,
    pointHoverBorderWidth: 2,
  });

  function mount(id, config) {
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    return new Chart(canvas, { ...config, plugins: [crosshair] });
  }

  mount('chart-traffic', {
    type: 'line',
    data: { labels: data.labels, datasets: [line('Посетители', data.visitors, C.s1, true), line('Просмотры', data.pageViews, C.s2)] },
    options: baseOptions((v) => nf.format(v)),
  });

  mount('chart-revenue', {
    type: 'bar',
    data: {
      labels: data.labels,
      datasets: [{
        label: 'Выручка',
        data: data.revenue,
        backgroundColor: C.s1,
        hoverBackgroundColor: token('--terracotta-700', '#9a3b1a'),
        borderRadius: { topLeft: 4, topRight: 4 },
        borderSkipped: 'bottom',
        maxBarThickness: 24,
        categoryPercentage: 0.8,
        barPercentage: 0.85,
      }],
    },
    options: baseOptions(money),
  });

  mount('chart-orders', {
    type: 'line',
    data: { labels: data.labels, datasets: [line('Оплачено', data.paidOrders, C.s1), line('Оформлено', data.orders, C.s2)] },
    options: baseOptions((v) => nf.format(v), (v) => nf.format(v)),
  });

  mount('chart-telegram', {
    type: 'line',
    data: { labels: data.tg.labels, datasets: [line('Запуски бота', data.tg.botStarts, C.s1), line('Открытия мини-приложения', data.tg.tmaOpens, C.s2)] },
    options: baseOptions((v) => nf.format(v), (v) => nf.format(v)),
  });

  window.addEventListener('scroll', () => {
    tip.style.opacity = '0';
  }, { passive: true });
})();
