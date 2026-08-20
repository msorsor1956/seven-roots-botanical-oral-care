(() => {
  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const accessShell = qs('[data-access-shell]');
  const operations = qs('[data-operations]');
  const sessionActions = qs('[data-session-actions]');
  const workspaceStatus = qs('[data-workspace-status]');
  const csrfStorageKey = 'seven-roots-staff-csrf';
  let csrfToken = sessionStorage.getItem(csrfStorageKey) || '';
  let workspace = null;

  const permission = (name) => Boolean(workspace?.user?.permissions?.includes(name));
  const locationLabel = (location) => location === 'us' ? 'U.S. fulfillment' : location === 'liberia' ? 'Liberia warehouse' : 'Both locations';
  const statusLabel = (value) => String(value || 'unknown').replaceAll('_', ' ');
  const formatDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? 'Not available' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  };
  const formatMoney = (amount, currency) => Number.isInteger(amount) && currency
    ? new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount / 100)
    : 'Not available';
  const setStatus = (element, message, isError = false) => {
    element.textContent = message;
    element.classList.toggle('is-error', isError);
  };
  const statusClass = (value) => {
    if (['blocked', 'sold_out', 'rejected', 'returned', 'inactive'].includes(value)) return ' is-danger';
    if (['urgent', 'low_stock', 'submitted', 'approved_pending_zoho', 'in_transit', 'unfulfilled'].includes(value)) return ' is-warning';
    return '';
  };
  const makeStatus = (value) => {
    const badge = document.createElement('span');
    badge.className = `status-label${statusClass(value)}`;
    badge.textContent = statusLabel(value);
    return badge;
  };

  const api = async (path, options = {}) => {
    const method = options.method || 'GET';
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' && csrfToken ? { 'x-csrf-token': csrfToken } : {})
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error?.message || 'The staff API could not complete this request.');
      error.code = payload.error?.code || 'request_failed';
      error.details = payload.error?.details || {};
      throw error;
    }
    return payload.data;
  };

  const actionButton = (label, action, secondary = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (secondary) button.className = 'secondary';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await action(); } catch (error) { setStatus(workspaceStatus, error.message, true); } finally { button.disabled = false; }
    });
    return button;
  };

  const runWorkspaceAction = async (path, options, message) => {
    setStatus(workspaceStatus, 'Saving your update...');
    await api(path, options);
    await loadWorkspace();
    setStatus(workspaceStatus, message);
  };

  const renderTasks = () => {
    const form = qs('[data-task-form]');
    form.hidden = !permission('tasks.manage');
    const locationSelect = qs('[data-task-location]');
    locationSelect.replaceChildren();
    workspace.user.locations.forEach((location) => locationSelect.append(new Option(locationLabel(location), location)));
    if (workspace.user.role === 'owner') locationSelect.append(new Option('Both locations', 'both'));

    const list = qs('[data-task-list]');
    list.replaceChildren();
    if (!workspace.tasks.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No work is waiting for this role and location.';
      list.append(empty);
      return;
    }
    workspace.tasks.forEach((task) => {
      const row = document.createElement('article');
      row.className = 'task-row';
      const copy = document.createElement('div');
      copy.className = 'task-copy';
      const title = document.createElement('h3');
      title.textContent = task.title;
      const description = document.createElement('p');
      description.textContent = task.description || 'No additional instructions.';
      copy.append(title, description);

      const meta = document.createElement('div');
      meta.className = 'task-meta';
      const type = document.createElement('strong');
      type.textContent = statusLabel(task.type);
      const location = document.createElement('span');
      location.textContent = locationLabel(task.location);
      const owner = document.createElement('span');
      owner.textContent = task.assignedTo ? (task.assignedTo === workspace.user.id ? 'Assigned to you' : 'Assigned') : 'Open to claim';
      meta.append(type, location, owner);
      const badge = makeStatus(task.priority === 'urgent' && task.status !== 'completed' ? 'urgent' : task.status);
      const actions = document.createElement('div');
      actions.className = 'task-actions';
      const canUpdate = permission('tasks.update') && (permission('tasks.manage') || !task.assignedTo || task.assignedTo === workspace.user.id);
      if (canUpdate && task.status === 'open') {
        actions.append(actionButton(task.assignedTo ? 'Start' : 'Claim task', () => runWorkspaceAction(
          `/api/v1/staff/tasks/${encodeURIComponent(task.id)}`,
          { method: 'PATCH', body: { assignedTo: workspace.user.id, status: 'in_progress' } },
          `${task.title} is now in progress.`
        )));
      }
      if (canUpdate && ['open', 'in_progress', 'blocked'].includes(task.status)) {
        actions.append(actionButton('Complete', () => runWorkspaceAction(
          `/api/v1/staff/tasks/${encodeURIComponent(task.id)}`,
          { method: 'PATCH', body: { status: 'completed' } },
          `${task.title} was completed.`
        )));
      }
      if (canUpdate && task.status === 'in_progress') {
        actions.append(actionButton('Block', () => runWorkspaceAction(
          `/api/v1/staff/tasks/${encodeURIComponent(task.id)}`,
          { method: 'PATCH', body: { status: 'blocked' } },
          `${task.title} was marked blocked.`
        ), true));
      }
      row.append(copy, meta, badge, actions);
      list.append(row);
    });
  };

  const renderInventory = () => {
    const source = qs('[data-inventory-source]');
    source.textContent = workspace.zoho?.inventoryAuthority ? 'Zoho controlled' : 'Local readiness mode';
    source.className = `source-badge${workspace.zoho?.inventoryAuthority ? '' : ' is-warning'}`;
    const grid = qs('[data-staff-inventory]');
    grid.replaceChildren();
    if (!permission('inventory.view')) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Inventory access is not assigned to this role.';
      grid.append(empty);
    } else {
      workspace.inventory.forEach((item) => {
        const card = document.createElement('article');
        card.className = 'inventory-card';
        const header = document.createElement('header');
        const heading = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = item.formatName;
        const location = document.createElement('small');
        location.textContent = `${locationLabel(item.location)} | ${item.sku}`;
        heading.append(title, location);
        header.append(heading, makeStatus(item.status));
        const data = document.createElement('dl');
        [['On hand', item.tracking ? item.stockOnHand : 'Not tracked'], ['Reorder at', item.reorderLevel]].forEach(([label, value]) => {
          const group = document.createElement('div');
          const term = document.createElement('dt');
          term.textContent = label;
          const description = document.createElement('dd');
          description.textContent = value;
          group.append(term, description);
          data.append(group);
        });
        card.append(header, data);
        if (permission('inventory.count')) {
          const form = document.createElement('form');
          form.className = 'count-form';
          const quantityLabel = document.createElement('label');
          const quantityText = document.createElement('span');
          quantityText.textContent = 'Physical count';
          const quantity = document.createElement('input');
          quantity.type = 'number';
          quantity.min = '0';
          quantity.max = '1000000';
          quantity.required = true;
          quantityLabel.append(quantityText, quantity);
          const reasonLabel = document.createElement('label');
          const reasonText = document.createElement('span');
          reasonText.textContent = 'Reason';
          const reason = document.createElement('input');
          reason.maxLength = 240;
          reason.value = 'Physical inventory count';
          reasonLabel.append(reasonText, reason);
          const submit = document.createElement('button');
          submit.type = 'submit';
          submit.textContent = 'Submit';
          form.append(quantityLabel, reasonLabel, submit);
          form.addEventListener('submit', async (event) => {
            event.preventDefault();
            submit.disabled = true;
            try {
              await runWorkspaceAction('/api/v1/staff/inventory/counts', {
                method: 'POST',
                body: { location: item.location, formatSlug: item.formatSlug, countedStock: Number(quantity.value), reason: reason.value }
              }, `${item.formatName} count was submitted.`);
            } catch (error) {
              setStatus(workspaceStatus, error.message, true);
            } finally { submit.disabled = false; }
          });
          card.append(form);
        }
        grid.append(card);
      });
    }

    const countList = qs('[data-count-list]');
    countList.replaceChildren();
    if (!workspace.stockCounts.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No physical counts have been submitted.';
      countList.append(empty);
      return;
    }
    workspace.stockCounts.forEach((count) => {
      const row = document.createElement('article');
      row.className = 'count-row';
      const meta = document.createElement('div');
      meta.className = 'count-meta';
      const number = document.createElement('strong');
      number.textContent = count.countNumber;
      const product = document.createElement('span');
      product.textContent = `${count.formatName} | ${locationLabel(count.location)}`;
      const submitter = document.createElement('span');
      submitter.textContent = `Submitted by ${count.submittedByName}`;
      meta.append(number, product, submitter);
      const expected = document.createElement('div');
      expected.className = 'count-quantity';
      expected.textContent = count.expectedStock ?? 'Not tracked';
      const expectedLabel = document.createElement('small');
      expectedLabel.textContent = 'Expected';
      expected.append(expectedLabel);
      const counted = document.createElement('div');
      counted.className = 'count-quantity';
      counted.textContent = count.countedStock;
      const countedLabel = document.createElement('small');
      countedLabel.textContent = 'Counted';
      counted.append(countedLabel);
      const variance = document.createElement('div');
      variance.className = 'count-quantity';
      variance.textContent = count.variance ?? 'Not available';
      const varianceLabel = document.createElement('small');
      varianceLabel.textContent = 'Variance';
      variance.append(varianceLabel);
      const actions = document.createElement('div');
      actions.className = 'task-actions';
      actions.append(makeStatus(count.status));
      if (permission('inventory.approve') && count.status === 'submitted' && count.submittedBy !== workspace.user.id) {
        actions.append(actionButton('Approve', () => runWorkspaceAction(
          `/api/v1/staff/inventory/counts/${encodeURIComponent(count.id)}/review`,
          { method: 'POST', body: { decision: 'approve' } },
          `${count.countNumber} was approved.`
        )));
        actions.append(actionButton('Reject', () => runWorkspaceAction(
          `/api/v1/staff/inventory/counts/${encodeURIComponent(count.id)}/review`,
          { method: 'POST', body: { decision: 'reject' } },
          `${count.countNumber} was rejected.`
        ), true));
      }
      row.append(meta, expected, counted, variance, actions);
      countList.append(row);
    });
  };

  const renderTransfers = () => {
    qs('[data-transfer-form]').hidden = !permission('transfers.create');
    const list = qs('[data-transfer-list]');
    list.replaceChildren();
    if (!permission('transfers.view') || !workspace.transfers.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = permission('transfers.view') ? 'No Liberia to U.S. transfers have been prepared.' : 'Transfer access is not assigned to this role.';
      list.append(empty);
      return;
    }
    workspace.transfers.forEach((transfer) => {
      const card = document.createElement('article');
      card.className = 'transfer-card';
      const copy = document.createElement('div');
      const title = document.createElement('h3');
      title.textContent = transfer.transferNumber;
      const route = document.createElement('p');
      route.textContent = `${locationLabel(transfer.fromLocation)} to ${locationLabel(transfer.toLocation)}`;
      copy.append(title, route, makeStatus(transfer.status));
      const items = document.createElement('div');
      items.className = 'transfer-items';
      transfer.items.forEach((item) => {
        const line = document.createElement('span');
        line.textContent = `${item.quantity} x ${item.formatName}`;
        items.append(line);
      });
      const shipping = document.createElement('div');
      shipping.className = 'transfer-shipping';
      const shippingTitle = document.createElement('strong');
      shippingTitle.textContent = transfer.status === 'in_transit' ? 'Shipment details' : 'Control record';
      const shippingText = document.createElement('span');
      shippingText.textContent = [transfer.carrier, transfer.trackingNumber, transfer.freightReference, transfer.zohoTransferOrderNumber].filter(Boolean).join(' | ') || `Updated ${formatDate(transfer.updatedAt)}`;
      shipping.append(shippingTitle, shippingText);
      const actions = document.createElement('div');
      actions.className = 'transfer-actions';
      if (transfer.status === 'draft' && permission('transfers.approve')) {
        actions.append(actionButton('Approve', () => runWorkspaceAction(
          `/api/v1/staff/transfers/${encodeURIComponent(transfer.id)}/approve`, { method: 'POST' }, `${transfer.transferNumber} was approved.`
        )));
      }
      if (transfer.status === 'approved' && permission('transfers.dispatch')) {
        const fields = document.createElement('div');
        fields.className = 'action-fields';
        const carrier = document.createElement('input');
        carrier.placeholder = 'Carrier';
        carrier.setAttribute('aria-label', `Carrier for ${transfer.transferNumber}`);
        const tracking = document.createElement('input');
        tracking.placeholder = 'Tracking number';
        tracking.setAttribute('aria-label', `Tracking number for ${transfer.transferNumber}`);
        fields.append(carrier, tracking);
        actions.append(fields, actionButton('Dispatch', () => runWorkspaceAction(
          `/api/v1/staff/transfers/${encodeURIComponent(transfer.id)}/dispatch`,
          { method: 'POST', body: { carrier: carrier.value, trackingNumber: tracking.value } },
          `${transfer.transferNumber} is in transit.`
        )));
      }
      if (transfer.status === 'in_transit' && permission('transfers.receive')) {
        actions.append(actionButton('Receive', () => runWorkspaceAction(
          `/api/v1/staff/transfers/${encodeURIComponent(transfer.id)}/receive`, { method: 'POST' }, `${transfer.transferNumber} was received.`
        )));
      }
      card.append(copy, items, shipping, actions);
      list.append(card);
    });
  };

  const renderOrders = () => {
    const list = qs('[data-staff-orders]');
    list.replaceChildren();
    if (!permission('orders.view') || !workspace.orders.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = permission('orders.view') ? 'No paid orders are ready.' : 'Order access is not assigned to this role.';
      list.append(empty);
      return;
    }
    workspace.orders.forEach((order) => {
      const card = document.createElement('article');
      card.className = 'order-card';
      const copy = document.createElement('div');
      const title = document.createElement('h3');
      title.textContent = order.orderNumber;
      const product = document.createElement('p');
      product.textContent = `${order.quantity} x ${order.formatName} | ${order.sku}`;
      copy.append(title, product, makeStatus(order.fulfillmentStatus));
      const customer = document.createElement('div');
      customer.className = 'order-customer';
      const name = document.createElement('strong');
      name.textContent = order.customer?.name || 'Customer';
      const email = document.createElement('a');
      email.href = `mailto:${order.customer?.email || ''}`;
      email.textContent = order.customer?.email || 'Email unavailable';
      customer.append(name, email);
      if (order.shipping?.address) {
        const address = document.createElement('div');
        address.className = 'order-address';
        address.textContent = [order.shipping.address.line1, order.shipping.address.line2, order.shipping.address.city, order.shipping.address.state, order.shipping.address.postalCode, order.shipping.address.country].filter(Boolean).join(', ');
        customer.append(address);
      }
      const detail = document.createElement('div');
      detail.className = 'order-customer';
      const detailTitle = document.createElement('strong');
      detailTitle.textContent = order.amountTotal !== undefined ? formatMoney(order.amountTotal, order.currency) : 'Fulfillment';
      const detailText = document.createElement('span');
      detailText.textContent = order.trackingNumber ? `${order.carrier} | ${order.trackingNumber}` : `Paid ${formatDate(order.createdAt)}`;
      detail.append(detailTitle, detailText);
      const actions = document.createElement('div');
      actions.className = 'order-actions';
      if (permission('orders.fulfill')) {
        const next = { unfulfilled: 'picking', picking: 'packed', shipped: 'delivered' }[order.fulfillmentStatus];
        if (next) {
          actions.append(actionButton(next === 'picking' ? 'Start picking' : next === 'packed' ? 'Mark packed' : 'Mark delivered', () => runWorkspaceAction(
            `/api/v1/staff/orders/${encodeURIComponent(order.id)}/fulfillment`,
            { method: 'PATCH', body: { status: next, assignedTo: workspace.user.id } },
            `${order.orderNumber} moved to ${statusLabel(next)}.`
          )));
        }
        if (order.fulfillmentStatus === 'packed') {
          const shipForm = document.createElement('form');
          shipForm.className = 'ship-form';
          const carrierLabel = document.createElement('label');
          const carrierText = document.createElement('span');
          carrierText.textContent = 'Carrier';
          const carrier = document.createElement('input');
          carrier.required = true;
          carrierLabel.append(carrierText, carrier);
          const trackingLabel = document.createElement('label');
          const trackingText = document.createElement('span');
          trackingText.textContent = 'Tracking';
          const tracking = document.createElement('input');
          tracking.required = true;
          trackingLabel.append(trackingText, tracking);
          const submit = document.createElement('button');
          submit.type = 'submit';
          submit.textContent = 'Ship';
          shipForm.append(carrierLabel, trackingLabel, submit);
          shipForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            submit.disabled = true;
            try {
              await runWorkspaceAction(`/api/v1/staff/orders/${encodeURIComponent(order.id)}/fulfillment`, {
                method: 'PATCH', body: { status: 'shipped', assignedTo: workspace.user.id, carrier: carrier.value, trackingNumber: tracking.value }
              }, `${order.orderNumber} was marked shipped.`);
            } catch (error) { setStatus(workspaceStatus, error.message, true); } finally { submit.disabled = false; }
          });
          actions.append(shipForm);
        }
        if (['shipped', 'delivered'].includes(order.fulfillmentStatus)) {
          actions.append(actionButton('Record return', () => runWorkspaceAction(
            `/api/v1/staff/orders/${encodeURIComponent(order.id)}/fulfillment`,
            { method: 'PATCH', body: { status: 'returned', assignedTo: workspace.user.id } },
            `${order.orderNumber} was marked returned.`
          ), true));
        }
      }
      card.append(copy, customer, detail, actions);
      list.append(card);
    });
  };

  const renderFinance = () => {
    const panel = qs('[data-staff-finance]');
    panel.replaceChildren();
    if (!workspace.finance) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Financial access is not assigned to this role.';
      panel.append(empty);
      return;
    }
    if (!workspace.finance.totals.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Financial totals will appear after the first completed payment.';
      panel.append(empty);
      return;
    }
    workspace.finance.totals.forEach((total) => {
      [['Gross sales', total.grossSales], ['Shipping', total.shippingRevenue], ['Refunds', total.refunds], ['Net collected', total.netCollected]].forEach(([label, amount]) => {
        const card = document.createElement('article');
        const name = document.createElement('span');
        name.textContent = `${label} | ${total.currency}`;
        const value = document.createElement('b');
        value.textContent = formatMoney(amount, total.currency);
        card.append(name, value);
        panel.append(card);
      });
    });
  };

  const renderAudit = () => {
    const list = qs('[data-audit-list]');
    list.replaceChildren();
    if (!permission('audit.view') || !workspace.audit.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = permission('audit.view') ? 'No staff activity has been recorded yet.' : 'Audit access is not assigned to this role.';
      list.append(empty);
      return;
    }
    workspace.audit.forEach((record) => {
      const row = document.createElement('article');
      row.className = 'audit-row';
      const copy = document.createElement('div');
      copy.className = 'audit-copy';
      const action = document.createElement('strong');
      action.textContent = record.summary || statusLabel(record.action);
      const entity = document.createElement('span');
      entity.textContent = `${statusLabel(record.entityType)} | ${record.entityId}`;
      copy.append(action, entity);
      const actor = document.createElement('div');
      actor.className = 'audit-meta';
      const actorName = document.createElement('strong');
      actorName.textContent = record.actorName;
      const actorRole = document.createElement('span');
      actorRole.textContent = statusLabel(record.actorRole);
      actor.append(actorName, actorRole);
      const time = document.createElement('div');
      time.className = 'audit-meta';
      const location = document.createElement('strong');
      location.textContent = record.location ? record.location.split(',').map(locationLabel).join(', ') : 'System';
      const date = document.createElement('span');
      date.textContent = formatDate(record.createdAt);
      time.append(location, date);
      row.append(copy, actor, time);
      list.append(row);
    });
  };

  const renderNavigation = () => {
    const access = {
      work: permission('tasks.view'),
      inventory: permission('inventory.view'),
      transfers: permission('transfers.view'),
      orders: permission('orders.view'),
      finance: permission('finance.view'),
      audit: permission('audit.view')
    };
    qsa('[data-view]').forEach((button) => { button.hidden = !access[button.dataset.view]; });
    const current = qs('[data-view][aria-current="page"]');
    if (!current || current.hidden) {
      const first = qsa('[data-view]').find((button) => !button.hidden);
      if (first) first.click();
    }
  };

  const renderWorkspace = () => {
    qs('[data-session-identity]').textContent = `${workspace.user.name} | ${workspace.user.roleLabel}`;
    qs('[data-welcome]').textContent = `Welcome, ${workspace.user.name.split(' ')[0]}.`;
    qs('[data-location-label]').textContent = workspace.user.locations.map(locationLabel).join(' and ');
    Object.entries(workspace.summary).forEach(([key, value]) => {
      const element = qs(`[data-metric="${key}"]`);
      if (element) element.textContent = value;
    });
    renderTasks();
    renderInventory();
    renderTransfers();
    renderOrders();
    renderFinance();
    renderAudit();
    renderNavigation();
  };

  const loadWorkspace = async () => {
    setStatus(workspaceStatus, 'Refreshing assigned work...');
    workspace = await api('/api/v1/staff/workspace');
    renderWorkspace();
    setStatus(workspaceStatus, `Updated ${new Date().toLocaleTimeString()}.`);
    accessShell.hidden = true;
    operations.hidden = false;
    sessionActions.hidden = false;
  };

  qsa('[data-view]').forEach((button) => button.addEventListener('click', () => {
    qsa('[data-view]').forEach((item) => item.removeAttribute('aria-current'));
    button.setAttribute('aria-current', 'page');
    qsa('[data-workspace-view]').forEach((view) => { view.hidden = view.dataset.workspaceView !== button.dataset.view; });
  }));

  qs('[data-task-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = qs('button[type="submit"]', event.currentTarget);
    button.disabled = true;
    try {
      await runWorkspaceAction('/api/v1/staff/tasks', {
        method: 'POST',
        body: { title: form.get('title'), type: form.get('type'), location: form.get('location'), priority: form.get('priority'), description: form.get('description') }
      }, 'Task created.');
      event.currentTarget.reset();
    } catch (error) { setStatus(workspaceStatus, error.message, true); } finally { button.disabled = false; }
  });

  qs('[data-transfer-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const items = ['travel-sleeve', 'daily-ritual', 'family-reserve']
      .map((formatSlug) => ({ formatSlug, quantity: Number(form.get(formatSlug)) }))
      .filter((item) => Number.isInteger(item.quantity) && item.quantity > 0);
    const button = qs('button[type="submit"]', event.currentTarget);
    button.disabled = true;
    try {
      await runWorkspaceAction('/api/v1/staff/transfers', {
        method: 'POST', body: { fromLocation: 'liberia', toLocation: 'us', items, freightReference: form.get('freightReference'), notes: form.get('notes') }
      }, 'Transfer draft created.');
      event.currentTarget.reset();
    } catch (error) { setStatus(workspaceStatus, error.message, true); } finally { button.disabled = false; }
  });

  const establishSession = async (data) => {
    csrfToken = data.csrfToken;
    sessionStorage.setItem(csrfStorageKey, csrfToken);
    await loadWorkspace();
  };

  qs('[data-login-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = qs('button[type="submit"]', event.currentTarget);
    button.disabled = true;
    setStatus(qs('[data-login-status]'), 'Verifying staff access...');
    try {
      await establishSession(await api('/api/v1/staff/auth/login', { method: 'POST', body: { email: form.get('email'), password: form.get('password') } }));
      event.currentTarget.reset();
    } catch (error) { setStatus(qs('[data-login-status]'), error.message, true); } finally { button.disabled = false; }
  });

  qs('[data-invite-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = qs('button[type="submit"]', event.currentTarget);
    if (form.get('password') !== form.get('confirmation')) {
      setStatus(qs('[data-invite-status]'), 'The password confirmation does not match.', true);
      return;
    }
    button.disabled = true;
    setStatus(qs('[data-invite-status]'), 'Activating your staff account...');
    try {
      await establishSession(await api('/api/v1/staff/auth/accept-invite', { method: 'POST', body: { token: form.get('token'), password: form.get('password') } }));
      history.replaceState({}, document.title, 'staff');
    } catch (error) {
      const detail = Object.values(error.details || {})[0];
      setStatus(qs('[data-invite-status]'), detail || error.message, true);
    } finally { button.disabled = false; }
  });

  qs('[data-refresh]').addEventListener('click', () => loadWorkspace().catch((error) => setStatus(workspaceStatus, error.message, true)));
  qs('[data-sign-out]').addEventListener('click', async () => {
    try { await api('/api/v1/staff/auth/logout', { method: 'POST', body: {} }); } catch {}
    csrfToken = '';
    sessionStorage.removeItem(csrfStorageKey);
    workspace = null;
    operations.hidden = true;
    sessionActions.hidden = true;
    accessShell.hidden = false;
    qs('[data-login-form]').hidden = false;
    qs('[data-invite-form]').hidden = true;
    history.replaceState({}, document.title, 'staff');
  });

  const invitationToken = new URLSearchParams(location.search).get('invite');
  if (invitationToken) {
    qs('[data-login-form]').hidden = true;
    const inviteForm = qs('[data-invite-form]');
    inviteForm.hidden = false;
    inviteForm.elements.token.value = invitationToken;
  } else {
    api('/api/v1/staff/auth/session')
      .then((data) => establishSession(data))
      .catch(() => {
        csrfToken = '';
        sessionStorage.removeItem(csrfStorageKey);
      });
  }
})();
