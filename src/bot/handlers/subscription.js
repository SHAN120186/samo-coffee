// Subscription plans, "Моя подписка" (status, paid period, renewal).
import * as subscriptions from '../../services/subscriptions.js';
import { formatSum } from '../../lib/money.js';
import { truncate } from '../../lib/escape.js';
import { cb, inline } from '../keyboards.js';
import { sendCard } from '../photos.js';
import { ack, show } from '../ui.js';
import { startCheckout, renewSubscription } from './checkout.js';
import * as texts from '../texts.js';

const planRows = (plans) => plans.map((p) => [cb(truncate(`${p.title} · ${formatSum(p.price)}`, 60), `plan:${p.id}`)]);

/** All active plans. */
export async function showPlans(ctx) {
  const plans = subscriptions.listPlans();
  await ack(ctx);
  await show(ctx, texts.plansText(plans), inline(planRows(plans)));
}

/** Find an active plan by id or slug (deep links use either). */
export function findPlan(idOrSlug) {
  const key = String(idOrSlug ?? '').trim();
  const plan = /^\d+$/.test(key) ? subscriptions.getPlan(Number(key)) : subscriptions.getPlanBySlug(key);
  return plan && plan.active ? plan : null;
}

/** Plan card with a picture and "Оформить подписку". */
export async function showPlan(ctx, idOrSlug) {
  const plan = findPlan(idOrSlug);
  if (!plan) {
    await ack(ctx, 'Этот план сейчас недоступен', { alert: true });
    if (!ctx.callbackQuery) await showPlans(ctx);
    return;
  }
  await ack(ctx);
  const current = subscriptions.getCurrentForTgUser(ctx.from.id);
  const samePlan = current && current.plan_id === plan.id;
  await sendCard(ctx.api, ctx.chat.id, plan.image, texts.planCard(plan), {
    reply_markup: inline([
      [cb(`${samePlan ? '🔁 Продлить' : '✅ Оформить подписку'} · ${formatSum(plan.price)}`, samePlan ? 'renew' : `sub:${plan.id}`)],
      [cb('← Все планы', 'plans')],
    ]),
  });
}

/** "🔁 Моя подписка": the current subscription or an invitation to choose a plan. */
export async function showSubscription(ctx) {
  const sub = subscriptions.getCurrentForTgUser(ctx.from.id);
  await ack(ctx);
  if (!sub) {
    const plans = subscriptions.listPlans();
    await show(ctx, texts.noSubscription(plans), inline(planRows(plans)));
    return;
  }
  await show(ctx, texts.subscriptionCard(sub), inline([
    [cb(`🔁 Продлить на ${texts.periodLabel(sub.plan_period_days)} · ${formatSum(sub.plan_price)}`, 'renew')],
    [cb('Все планы', 'plans'), cb('💬 Вопрос по подписке', 'support')],
  ]));
}

export async function subscribe(ctx, planId) {
  await startCheckout(ctx, 'plan', planId);
}

/** "Продлить": straight to the payment when we know the customer, otherwise the plan list. */
export async function renew(ctx) {
  const done = await renewSubscription(ctx);
  if (!done) {
    ctx.fresh = true;
    await showPlans(ctx);
  }
}
