// Date formatting in the business timezone (config.tzOffsetMinutes, Tashkent by default), Russian locale.
import { config } from '../config.js';

const shift = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getTime() + config.tzOffsetMinutes * 60000);
};
const fmt = (value, options) => {
  const d = shift(value);
  return d ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', ...options }).format(d) : '';
};

/** "24 ноября 2026" */
export const formatDate = (v) => fmt(v, { day: 'numeric', month: 'long', year: 'numeric' }).replace(' г.', '');
/** "24 нояб., 14:05" */
export const formatDateTime = (v) => fmt(v, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
/** "24.11.2026" */
export const formatDateShort = (v) => fmt(v, { day: '2-digit', month: '2-digit', year: 'numeric' });
/** "24.11.2026, 14:05" */
export const formatDateTimeFull = (v) => fmt(v, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
/** "24 нояб." (chart axis) */
export const formatDayMonth = (v) => fmt(v, { day: 'numeric', month: 'short' });
/** "2026-11-24" for <input type="date"> / <time datetime> */
export const isoDate = (v) => {
  const d = shift(v);
  return d ? d.toISOString().slice(0, 10) : '';
};

/** "только что", "5 мин назад", "3 ч назад", "вчера", otherwise a date. */
export function timeAgo(v, nowMs = Date.now()) {
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, nowMs - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  if (h < 48) return 'вчера';
  return formatDate(v);
}
