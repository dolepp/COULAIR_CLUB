// Скидка применяется к рассчитанной стоимости доставки, с округлением до копеек.
export function deliveryPrice(cost, discountPercent = 0) {
  const price = Number(cost), percent = Number(discountPercent);
  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error('Некорректная стоимость доставки');
  }
  return Math.round(price * (100 - percent)) / 100;
}

export function deliveryPaymentPlan(cost, discountPercent = 0) {
  const customerCost = deliveryPrice(cost, discountPercent);
  return { paymentMethod: 'on_receipt', customerCost, onlineCost: 0,
    senderCost: Math.round((Number(cost) - customerCost) * 100) / 100 };
}
// Старые оплаченные заказы сохраняют прежнюю схему оплаты.
export const deliveryOnlineCharge = delivery => delivery.paymentMethod === 'on_receipt' ? 0 : Number(delivery.customerCost || 0);
export const deliveryStoreExpense = delivery => delivery.paymentMethod === 'on_receipt'
  ? Number(delivery.senderCost ?? Math.max(0, Number(delivery.cdekCost || 0) - Number(delivery.customerCost || 0)))
  : Number(delivery.cdekCost || 0);
