(() => {
  const qs = (selector) => document.querySelector(selector);
  const apiBase = qs('meta[name="seven-roots-api-base"]')?.content.replace(/\/$/u, '') || '';
  const sessionId = new URL(window.location.href).searchParams.get('session_id') || '';
  const title = qs('[data-title]');
  const message = qs('[data-message]');
  const mark = qs('[data-status-mark]');
  const details = qs('[data-order-details]');

  const money = (amount, currency) => Number.isInteger(amount) && currency
    ? new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount / 100)
    : 'Confirmed in Checkout';

  const showOrder = (order) => {
    const paid = order.status === 'paid';
    title.textContent = paid ? 'Your ritual is confirmed.' : 'Your order is being confirmed.';
    message.textContent = paid
      ? 'Payment is complete. Keep this order reference for your records; fulfillment updates will follow by email.'
      : 'The order was received, but its payment is still processing. We will update the status when Stripe confirms it.';
    mark.classList.add(paid ? 'is-success' : 'is-warning');
    qs('[data-order-number]').textContent = order.orderNumber;
    qs('[data-format]').textContent = `${order.formatName || 'SEVEN ROOTS format'}${order.sku ? ` · ${order.sku}` : ''}`;
    qs('[data-quantity]').textContent = `${order.quantity} ${order.quantity === 1 ? 'pack' : 'packs'}`;
    qs('[data-subtotal]').textContent = money(order.amountSubtotal, order.currency);
    qs('[data-shipping]').textContent = money(order.amountShipping, order.currency);
    qs('[data-total]').textContent = money(order.amountTotal, order.currency);
    qs('[data-order-status]').textContent = order.status.replaceAll('_', ' ');
    details.hidden = false;
  };

  const showError = (copy) => {
    title.textContent = 'We could not load the confirmation.';
    message.textContent = copy;
    mark.classList.add('is-warning');
  };

  const lookup = async () => {
    if (!/^cs_[A-Za-z0-9_]+$/u.test(sessionId)) {
      showError('The Checkout Session reference is missing or invalid. Return to the collection or contact SEVEN ROOTS for help.');
      return;
    }
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fetch(`${apiBase}/api/v1/orders/lookup?session_id=${encodeURIComponent(sessionId)}`, { headers: { accept: 'application/json' } });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) {
        showOrder(payload.data);
        return;
      }
      if (response.status !== 404) {
        showError(payload.error?.message || 'The order service is temporarily unavailable. Your Stripe receipt remains authoritative.');
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1300 + attempt * 350));
    }
    showError('Stripe may still be delivering the signed confirmation. Check your Stripe receipt, then refresh this page in a moment.');
  };

  lookup().catch(() => showError('The order service is temporarily unavailable. No additional payment was attempted.'));
})();
