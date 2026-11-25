// Actions shared by several screens.
import { tg } from './tg.js';
import { addToCart } from './store.js';
import { setHTML, icon, toast, toastError } from './ui.js';
import { navigate } from './router.js';

/** "+" button of a product card: adds one unit, shows feedback on the button and a toast. */
export async function quickAdd(button) {
  if (button.disabled || button.dataset.busy) return;
  button.dataset.busy = '1';
  tg.haptic('light');
  try {
    const result = await addToCart(Number(button.dataset.add), 1);
    if (!result.added) {
      toast('Больше нет в наличии', { type: 'info' });
    } else {
      tg.haptic('success');
      button.classList.add('is-done');
      setHTML(button, icon('check', { stroke: 2.6 }));
      setTimeout(() => {
        button.classList.remove('is-done');
        setHTML(button, icon('plus', { stroke: 2.4 }));
      }, 1100);
      toast('Добавили в корзину', { type: 'success', action: { label: 'Открыть', onClick: () => navigate('/cart') } });
    }
  } catch (err) {
    toastError(err);
  } finally {
    delete button.dataset.busy;
  }
}
