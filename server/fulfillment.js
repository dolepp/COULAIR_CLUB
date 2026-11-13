// Цвет хранится одинаково в корзине, заказах и Google Таблице.
export function normalizeColor(value) {
  const color = String(value || 'черный').trim().toLowerCase().replaceAll('ё', 'е');
  if (['черный', 'black'].includes(color)) return 'черный';
  if (['белый', 'white'].includes(color)) return 'белый';
  return null;
}
export const colorLabel = color => normalizeColor(color) === 'белый' ? 'Белый' : 'Чёрный';
export function fulfillmentText(item) {
  return (item.fulfillment || []).map(f => `${f.qty} шт. — ${f.preorder ? 'Предзаказ · ' : ''}Отправка ${f.dispatchLabel}`).join('; ');
}
export function attachFulfillment(items, allocations = []) {
  items.forEach((item, index) => {
    if (item.id !== 'pants') return;
    const groups = new Map();
    for (const a of allocations.filter(a => a.itemIndex === index)) {
      const key = a.batch + '|' + a.dispatchLabel + '|' + a.preorder;
      const f = groups.get(key) || { batch: a.batch, qty: 0, dispatchLabel: a.dispatchLabel, preorder: a.preorder };
      f.qty++; groups.set(key, f);
    }
    item.fulfillment = [...groups.values()];
  });
}
