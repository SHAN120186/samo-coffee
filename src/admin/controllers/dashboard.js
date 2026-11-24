// Dashboard: first-party analytics for a date range + operational widgets.
import { Router } from 'express';
import * as analytics from '../../services/analytics.js';
import * as orders from '../../services/orders.js';
import * as feedback from '../../services/feedback.js';
import * as catalog from '../../services/catalog.js';
import * as subscriptions from '../../services/subscriptions.js';
import { formatDayMonth, formatDate } from '../../lib/dates.js';
import { view, flatQuery } from '../lib.js';

const router = Router();

/** Tiny inline SVG sparkline (server-rendered) for the KPI tiles. */
function sparkline(values, { width = 96, height = 28 } = {}) {
  const pts = values.map((v) => Number(v) || 0);
  if (pts.length < 2 || pts.every((v) => v === 0)) return '';
  const max = Math.max(...pts);
  const min = Math.min(...pts);
  const span = max - min || 1;
  const step = width / (pts.length - 1);
  const coords = pts.map((v, i) => `${(i * step).toFixed(1)},${(height - 3 - ((v - min) / span) * (height - 6)).toFixed(1)}`);
  const last = coords[coords.length - 1].split(',');
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true" focusable="false">`
    + `<polyline points="${coords.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`
    + `<circle cx="${last[0]}" cy="${last[1]}" r="2.5" fill="var(--series-1)"/></svg>`;
}

const dayLabel = (date) => formatDayMonth(`${date}T12:00:00Z`);

/**
 * Daily series → chart buckets with labels. Ranges longer than 45 days are summed by week:
 * a 90-day chart with daily marks is noise.
 */
function bucketize(series, keys) {
  if (series.length <= 45) return series.map((d) => ({ ...d, label: dayLabel(d.date) }));
  const out = [];
  for (let i = 0; i < series.length; i += 7) {
    const chunk = series.slice(i, i + 7);
    const bucket = { date: chunk[0].date, label: `${dayLabel(chunk[0].date)} – ${dayLabel(chunk[chunk.length - 1].date)}` };
    for (const key of keys) bucket[key] = chunk.reduce((sum, d) => sum + d[key], 0);
    out.push(bucket);
  }
  return out;
}

router.get('/', (req, res) => {
  const range = analytics.resolveRange(flatQuery(req.query));
  const data = analytics.dashboard(range);
  const series = bucketize(data.timeseries, ['visitors', 'pageViews', 'orders', 'paidOrders', 'revenue']);
  const tgSeries = bucketize(data.telegram.series, ['botStarts', 'tmaOpens', 'newUsers']);
  const weekly = series.length !== data.timeseries.length;

  const day = (d) => formatDate(`${d}T12:00:00Z`);
  res.render(view('dashboard'), {
    title: 'Дашборд',
    section: 'dashboard',
    range,
    rangeLabel: range.from === range.to ? day(range.from) : `${day(range.from)} — ${day(range.to)}`,
    prevLabel: range.prev.from === range.prev.to ? day(range.prev.from) : `${day(range.prev.from)} — ${day(range.prev.to)}`,
    presets: analytics.RANGE_PRESETS,
    d: data,
    weekly,
    spark: {
      revenue: sparkline(data.timeseries.map((x) => x.revenue)),
      paidOrders: sparkline(data.timeseries.map((x) => x.paidOrders)),
      visitors: sparkline(data.timeseries.map((x) => x.visitors)),
      pageViews: sparkline(data.timeseries.map((x) => x.pageViews)),
    },
    tmaFunnel: analytics.funnel(range, { channel: 'tma' }),
    recentOrders: orders.listOrders({ limit: 7 }).items,
    openThreads: feedback.listThreads({ status: 'open', limit: 5 }),
    lowStock: catalog.lowStock(5, 6),
    subStats: subscriptions.subscriptionStats(),
    chartData: {
      weekly,
      labels: series.map((s) => s.label),
      visitors: series.map((s) => s.visitors),
      pageViews: series.map((s) => s.pageViews),
      orders: series.map((s) => s.orders),
      paidOrders: series.map((s) => s.paidOrders),
      revenue: series.map((s) => s.revenue),
      tg: {
        labels: tgSeries.map((s) => s.label),
        botStarts: tgSeries.map((s) => s.botStarts),
        tmaOpens: tgSeries.map((s) => s.tmaOpens),
      },
    },
    series,
  });
});

export default router;
