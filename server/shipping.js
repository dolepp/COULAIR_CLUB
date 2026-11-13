// Скидка применяется к рассчитанной стоимости доставки, с округлением до копеек.
export function deliveryPrice(cost, discountPercent = 0) {
  const price = Number(cost), percent = Number(discountPercent);
  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error('Некорректная стоимость доставки');
  }
  return Math.round(price * (100 - percent)) / 100;
}
