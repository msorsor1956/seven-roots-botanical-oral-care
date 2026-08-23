(() => {
  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const loginView = qs('[data-login-view]');
  const dashboard = qs('[data-dashboard]');
  const headerActions = qs('[data-header-actions]');
  const loginForm = qs('[data-login-form]');
  const loginStatus = qs('[data-login-status]');
  const dashboardStatus = qs('[data-dashboard-status]');
  const formatNames = { 'travel-sleeve': 'Travel Sleeve', 'daily-ritual': 'Daily Ritual', 'family-reserve': 'Family Reserve' };
  const taskTypeNames = {
    receiving: 'Receiving', quality: 'Quality control', packing: 'Packing', stock_count: 'Stock count',
    transfer: 'Stock transfer', fulfillment: 'Order fulfillment', returns: 'Returns', support: 'Customer support',
    finance: 'Finance', general: 'General operations'
  };
  const taskLocationNames = { liberia: 'Liberia warehouse', us: 'U.S. fulfillment', both: 'Both locations' };
  let apiKey = sessionStorage.getItem('seven-roots-admin-key') || '';
  let collections = { orders: [], payments: [], inventory: [], waitlist: [], inquiries: [] };
  let currentZohoStatus = { configured: false, enabled: false, inventoryAuthority: false, mappings: [] };
  let staffUsers = [];
  let staffRoles = [];
  let adminTasks = [];

  const setStatus = (element, message, isError = false) => {
    element.textContent = message;
    element.classList.toggle('is-error', isError);
  };

  const api = async (path, options = {}) => {
    const response = await fetch(path, {
      method: options.method || 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {})
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error?.message || 'The private API could not be reached.');
      error.details = payload.error?.details || {};
      throw error;
    }
    return payload.data;
  };

  const uploadTaskFile = async (taskId, file) => {
    const response = await fetch(`/api/v1/admin/tasks/${encodeURIComponent(taskId)}/files`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
        'content-type': file.type || 'application/octet-stream',
        'x-file-name': file.name,
        'x-file-kind': file.type === 'application/pdf' || /\.(docx?|xlsx?|csv|txt)$/iu.test(file.name) ? 'sow' : 'reference',
        'x-file-phase': 'scope'
      },
      body: file
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || `${file.name} could not be uploaded.`);
    return payload.data;
  };

  const formatDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? '—' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  };
  const formatMonth = (value) => value === 'unknown'
    ? 'Unknown'
    : new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}-01T00:00:00Z`));
  const formatMoney = (amount, currency) => Number.isInteger(amount) && currency
    ? new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount / 100)
    : '—';
  const statusLabel = (value) => String(value || 'unknown').replaceAll('_', ' ');
  const whatsappUrl = (number, message = '') => {
    const digits = String(number || '').replace(/\D/g, '');
    return digits ? `https://wa.me/${digits}${message ? `?text=${encodeURIComponent(message)}` : ''}` : '';
  };
  const statusIsAlert = (value) => !['paid', 'pending', 'in_stock', 'not_tracked', 'active', 'ready', 'synced', 'sent', 'accepted'].includes(value);

  const addCells = (row, values) => values.forEach((value) => {
    const cell = row.insertCell();
    cell.textContent = value;
  });

  const addStatusCell = (row, value) => {
    const cell = row.insertCell();
    const status = document.createElement('span');
    status.className = `order-status${statusIsAlert(value) ? ' is-alert' : ''}`;
    status.textContent = statusLabel(value);
    cell.append(status);
  };

  const renderSummary = (summary) => {
    qs('[data-total-orders]').textContent = summary.paidOrderTotal;
    const revenue = Object.entries(summary.paidRevenue || {});
    qs('[data-paid-revenue]').textContent = revenue.length
      ? revenue.map(([currency, amount]) => formatMoney(amount, currency)).join(' · ')
      : '—';
    qs('[data-stock-available]').textContent = summary.trackedFormatTotal ? summary.trackedStockAvailable : 'Not set';
    qs('[data-total-payments]').textContent = summary.paymentTotal;
    const entries = Object.entries(summary.formatInterest || {}).sort((left, right) => right[1] - left[1]);
    const maximum = Math.max(1, ...entries.map(([, count]) => count));
    const bars = qs('[data-interest-bars]');
    bars.replaceChildren();
    Object.entries(formatNames).forEach(([slug, name]) => {
      const count = summary.formatInterest?.[slug] || 0;
      const row = document.createElement('div');
      row.className = 'interest-row';
      const label = document.createElement('span');
      label.textContent = name;
      const track = document.createElement('div');
      track.className = 'bar-track';
      const fill = document.createElement('div');
      fill.className = 'bar-fill';
      fill.style.width = `${(count / maximum) * 100}%`;
      track.append(fill);
      const value = document.createElement('b');
      value.textContent = count;
      row.append(label, track, value);
      bars.append(row);
    });
  };

  const renderFinancialReport = (report) => {
    const summary = qs('[data-finance-summary]');
    summary.replaceChildren();
    if (!report.totals.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Financial totals will appear after the first completed payment.';
      summary.append(empty);
    }
    report.totals.forEach((total) => {
      [
        ['Gross sales', total.grossSales],
        ['Product sales', total.productSales],
        ['Shipping collected', total.shippingRevenue],
        ['Tax collected', total.taxCollected],
        ['Refunds', total.refunds],
        ['Net collected', total.netCollected],
        ['Average order', total.averageOrderValue]
      ].forEach(([label, amount]) => {
        const card = document.createElement('article');
        const small = document.createElement('span');
        small.textContent = `${label} · ${total.currency}`;
        const value = document.createElement('b');
        value.textContent = formatMoney(amount, total.currency);
        card.append(small, value);
        summary.append(card);
      });
    });
    qs('[data-finance-note]').textContent = report.note;

    const monthlyBody = qs('[data-monthly-body]');
    monthlyBody.replaceChildren();
    if (!report.monthly.length) {
      const row = monthlyBody.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 6;
      cell.textContent = 'No completed payment periods yet.';
    }
    report.monthly.forEach((period) => {
      const row = monthlyBody.insertRow();
      addCells(row, [
        `${formatMonth(period.month)} · ${period.currency}`,
        period.paidOrders,
        formatMoney(period.grossSales, period.currency),
        formatMoney(period.refunds, period.currency),
        formatMoney(period.netCollected, period.currency)
      ]);
    });

    const productBody = qs('[data-product-performance-body]');
    productBody.replaceChildren();
    if (!report.productPerformance.length) {
      const row = productBody.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 5;
      cell.textContent = 'Product performance will appear after the first completed payment.';
    }
    report.productPerformance.forEach((product) => {
      const row = productBody.insertRow();
      addCells(row, [
        `${product.formatName} · ${product.sku}`,
        product.orders,
        product.quantity,
        formatMoney(product.productSales, product.currency),
        formatMoney(product.netCollected, product.currency)
      ]);
    });
  };

  const renderZoho = (status) => {
    currentZohoStatus = status;
    const badge = qs('[data-zoho-badge]');
    const state = status.inventoryAuthority
      ? 'Active inventory authority'
      : status.connected
        ? status.enabled ? 'Mapping required' : 'Verified · readiness mode'
        : status.configured ? 'Ready to test' : 'Not connected';
    badge.textContent = state;
    badge.classList.toggle('is-ready', status.inventoryAuthority || (status.connected && !status.enabled));
    badge.classList.toggle('is-alert', status.enabled && !status.inventoryAuthority);
    qs('[data-zoho-connection]').textContent = status.inventoryAuthority ? 'Live' : status.connected ? 'Verified' : status.configured ? 'Configured' : 'Waiting';
    qs('[data-zoho-datacenter]').textContent = [status.organizationId, status.dataCenter].filter(Boolean).join(' · ') || 'Zoho data center';
    qs('[data-zoho-liberia]').textContent = status.locations?.liberia?.name || 'Not mapped';
    qs('[data-zoho-us]').textContent = status.locations?.us?.name || 'Not mapped';
    qs('[data-zoho-orders]').textContent = (status.pendingOrders || 0) + (status.failedOrders || 0);
    qs('[data-zoho-note]').textContent = status.activationNote;

    const settings = qs('[data-zoho-settings]');
    settings.replaceChildren();
    if (status.missingSettings?.length) {
      status.missingSettings.forEach((name) => {
        const setting = document.createElement('span');
        setting.textContent = name;
        settings.append(setting);
      });
    } else {
      const ready = document.createElement('span');
      ready.className = 'is-set';
      ready.textContent = 'All secure Railway settings are present';
      settings.append(ready);
    }

    const body = qs('[data-zoho-mapping-body]');
    body.replaceChildren();
    if (!status.mappings?.length) {
      const row = body.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 6;
      cell.textContent = 'Run Test connection after adding the Railway settings.';
    }
    status.mappings?.forEach((mapping) => {
      const row = body.insertRow();
      addCells(row, [
        mapping.formatName,
        mapping.sku,
        mapping.matched ? `${mapping.zohoItemName} · ${mapping.zohoItemId}` : 'Not found',
        Number.isInteger(mapping.liberia?.available) ? mapping.liberia.available : '—',
        Number.isInteger(mapping.us?.available) ? mapping.us.available : '—'
      ]);
      addStatusCell(row, mapping.ready ? 'ready' : 'mapping_required');
    });

    const testButton = qs('[data-zoho-test]');
    const syncButton = qs('[data-zoho-sync]');
    const orderButton = qs('[data-zoho-orders-sync]');
    const connectButton = qs('[data-zoho-connect]');
    const provisionButton = qs('[data-zoho-provision]');
    connectButton.textContent = status.oauth?.connected ? 'Reconnect Zoho securely' : 'Connect Zoho securely';
    connectButton.disabled = !status.oauth?.configurationReady;
    connectButton.title = status.oauth?.configurationReady ? '' : `Add ${(status.oauth?.missingSettings || []).join(', ')} in Railway.`;
    provisionButton.disabled = !status.oauth?.connected;
    provisionButton.title = status.oauth?.connected ? '' : 'Connect Zoho before preparing products and the online-store customer.';
    testButton.disabled = !status.configured;
    syncButton.disabled = !status.configured;
    orderButton.disabled = !status.enabled || !status.inventoryAuthority || !((status.pendingOrders || 0) + (status.failedOrders || 0));
    testButton.title = status.configured ? '' : 'Add the listed settings in Railway first.';
    syncButton.title = testButton.title;
    orderButton.title = status.inventoryAuthority ? '' : 'Enable Zoho only after a verified inventory sync.';
    const message = status.lastError
      ? status.lastError
      : status.lastSuccessAt
        ? `Last inventory sync ${formatDate(status.lastSuccessAt)}.`
        : status.lastAttemptAt ? `Last connection check ${formatDate(status.lastAttemptAt)}.` : '';
    setStatus(qs('[data-zoho-status]'), message, Boolean(status.lastError));
  };

  const renderEmail = (status) => {
    const badge = qs('[data-email-badge]');
    badge.textContent = status.configured ? 'Invitation email ready' : 'Email setup required';
    badge.classList.toggle('is-ready', status.configured);
    badge.classList.toggle('is-alert', !status.configured);
    qs('[data-email-note]').textContent = status.configured
      ? `New and replacement staff invitations are sent automatically from ${status.from}. A recovery copy remains visible to the owner.`
      : `Employee records can be created, but automatic invitation email needs these Railway settings: ${(status.missingSettings || []).join(', ') || 'RESEND_API_KEY and EMAIL_FROM'}.`;
  };

  const renderWhatsApp = (status) => {
    const badge = qs('[data-whatsapp-badge]');
    badge.textContent = status.configured ? 'WhatsApp active' : 'WhatsApp setup required';
    badge.classList.toggle('is-ready', status.configured);
    badge.classList.toggle('is-alert', !status.configured);
    badge.title = status.configured
      ? `Task notifications use ${status.taskTemplate}.`
      : `Add ${(status.missingSettings || []).join(', ')} in Railway for automatic task notifications.`;
  };

  const populateTaskAssignees = (select, location, selected = '') => {
    select.replaceChildren(new Option('Leave open to claim', ''));
    staffUsers
      .filter((user) => user.status === 'active' && (location === 'both' || user.locations.includes(location)))
      .forEach((user) => select.append(new Option(`${user.name} · ${user.roleLabel}`, user.id)));
    select.value = selected;
  };

  const renderAdminTasks = (tasks) => {
    adminTasks = tasks;
    const active = tasks.filter((task) => !['completed'].includes(task.status));
    const pending = tasks.filter((task) => task.status === 'pending_approval');
    qs('[data-admin-task-open]').textContent = active.length;
    qs('[data-admin-task-pending]').textContent = pending.length;
    qs('[data-admin-task-total]').textContent = `${tasks.length} task${tasks.length === 1 ? '' : 's'}`;

    const list = qs('[data-admin-task-list]');
    list.replaceChildren();
    if (!tasks.length) {
      const empty = document.createElement('div');
      empty.className = 'task-empty-state';
      const title = document.createElement('strong');
      title.textContent = 'No operations tasks yet';
      const copy = document.createElement('p');
      copy.textContent = 'Create the first task and assign it to an active employee or manager.';
      empty.append(title, copy);
      list.append(empty);
      return;
    }

    const personById = new Map(staffUsers.map((user) => [user.id, user]));
    tasks.forEach((task) => {
      const card = document.createElement('article');
      card.className = `admin-task-card${task.status === 'completed' ? ' is-completed' : ''}`;

      const header = document.createElement('header');
      const identity = document.createElement('div');
      const eyebrow = document.createElement('p');
      eyebrow.className = 'task-card-eyebrow';
      eyebrow.textContent = `${taskTypeNames[task.type] || statusLabel(task.type)} · ${taskLocationNames[task.location] || task.location}`;
      const title = document.createElement('h4');
      title.textContent = task.title;
      identity.append(eyebrow, title);
      const badges = document.createElement('div');
      badges.className = 'admin-task-badges';
      if (task.priority === 'urgent' && task.status !== 'completed') {
        const urgent = document.createElement('span');
        urgent.className = 'task-badge is-urgent';
        urgent.textContent = 'Urgent';
        badges.append(urgent);
      }
      const state = document.createElement('span');
      state.className = `task-badge is-${task.status}`;
      state.textContent = statusLabel(task.status);
      badges.append(state);
      header.append(identity, badges);

      const scope = document.createElement('p');
      scope.className = 'admin-task-scope';
      scope.textContent = task.scopeOfWork || task.description || 'No Scope of Work was recorded.';

      const assignee = personById.get(task.assignedTo);
      const meta = document.createElement('dl');
      meta.className = 'admin-task-meta';
      [
        ['Assigned to', assignee?.name || 'Open to claim'],
        ['Created by', task.createdByName || 'Administration'],
        ['Due', task.dueAt ? formatDate(task.dueAt) : 'No due date'],
        ['Updated', formatDate(task.updatedAt)]
      ].forEach(([label, value]) => {
        const group = document.createElement('div');
        const term = document.createElement('dt');
        term.textContent = label;
        const description = document.createElement('dd');
        description.textContent = value;
        group.append(term, description);
        meta.append(group);
      });

      const evidence = document.createElement('div');
      evidence.className = 'admin-task-evidence';
      const evidenceLabel = document.createElement('strong');
      evidenceLabel.textContent = 'Required evidence';
      const evidenceItems = document.createElement('div');
      (task.evidenceRequirements || []).forEach((item) => {
        const tag = document.createElement('span');
        const complete = (task.attachments || []).some((file) => file.phase === 'completion' && file.family === item);
        tag.className = complete ? 'is-ready' : '';
        tag.textContent = `${complete ? '✓ ' : ''}${statusLabel(item)}`;
        evidenceItems.append(tag);
      });
      if (!(task.evidenceRequirements || []).length) evidenceItems.textContent = 'No evidence requirement';
      evidence.append(evidenceLabel, evidenceItems);

      const files = document.createElement('p');
      files.className = 'admin-task-file-count';
      const scopeFiles = (task.attachments || []).filter((file) => file.phase === 'scope').length;
      const completionFiles = (task.attachments || []).filter((file) => file.phase === 'completion').length;
      files.textContent = `${scopeFiles} SOW/reference file${scopeFiles === 1 ? '' : 's'} · ${completionFiles} completion file${completionFiles === 1 ? '' : 's'}`;

      card.append(header, scope, meta, evidence, files);

      if (task.status === 'pending_approval') {
        const notice = document.createElement('div');
        notice.className = 'task-approval-notice is-pending';
        const noticeTitle = document.createElement('strong');
        noticeTitle.textContent = 'Waiting for manager approval';
        const noticeCopy = document.createElement('p');
        noticeCopy.textContent = `${task.submittedByName || 'The assigned employee'} submitted this task ${formatDate(task.submittedAt)}. A different authorized manager must review the evidence in the staff portal.`;
        notice.append(noticeTitle, noticeCopy);
        card.append(notice);
      } else if (task.status === 'completed' && task.approval) {
        const notice = document.createElement('div');
        notice.className = 'task-approval-notice is-approved';
        const noticeTitle = document.createElement('strong');
        noticeTitle.textContent = '✓ Approved and completed';
        const noticeCopy = document.createElement('p');
        noticeCopy.textContent = `${task.approval.approvedByName} approved this work ${formatDate(task.approval.approvedAt)}${task.approval.note ? ` · ${task.approval.note}` : ''}`;
        notice.append(noticeTitle, noticeCopy);
        card.append(notice);
      } else {
        const allocation = document.createElement('form');
        allocation.className = 'task-allocation-form';
        const assignLabel = document.createElement('label');
        const assignText = document.createElement('span');
        assignText.textContent = 'Allocate to';
        const assignSelect = document.createElement('select');
        assignSelect.setAttribute('aria-label', `Allocate ${task.title}`);
        populateTaskAssignees(assignSelect, task.location, task.assignedTo);
        assignLabel.append(assignText, assignSelect);
        const priorityLabel = document.createElement('label');
        const priorityText = document.createElement('span');
        priorityText.textContent = 'Priority';
        const prioritySelect = document.createElement('select');
        prioritySelect.append(new Option('Normal', 'normal'), new Option('Urgent', 'urgent'));
        prioritySelect.value = task.priority;
        priorityLabel.append(priorityText, prioritySelect);
        const save = document.createElement('button');
        save.type = 'submit';
        save.textContent = task.assignedTo ? 'Update allocation' : 'Assign task';
        allocation.append(assignLabel, priorityLabel, save);
        allocation.addEventListener('submit', async (event) => {
          event.preventDefault();
          save.disabled = true;
          setStatus(qs('[data-admin-task-status]'), `Updating ${task.title}…`);
          try {
            await api(`/api/v1/admin/tasks/${encodeURIComponent(task.id)}`, {
              method: 'PATCH',
              body: { assignedTo: assignSelect.value, priority: prioritySelect.value }
            });
            await loadDashboard();
            setStatus(qs('[data-admin-task-status]'), `${task.title} was allocated successfully.`);
          } catch (error) {
            setStatus(qs('[data-admin-task-status]'), error.message, true);
            save.disabled = false;
          }
        });
        card.append(allocation);
      }

      list.append(card);
    });
  };

  const renderInventory = (items) => {
    const list = qs('[data-inventory-list]');
    list.replaceChildren();
    items.forEach((item) => {
      const form = document.createElement('form');
      form.className = 'inventory-row';
      form.dataset.formatSlug = item.formatSlug;
      const zohoControlled = item.source === 'zoho' && currentZohoStatus.inventoryAuthority;
      form.classList.toggle('is-external', zohoControlled);

      const identity = document.createElement('div');
      identity.className = 'inventory-identity';
      const status = document.createElement('span');
      status.className = `order-status${statusIsAlert(item.status) ? ' is-alert' : ''}`;
      status.textContent = statusLabel(item.status);
      const title = document.createElement('h3');
      title.textContent = item.formatName;
      const sku = document.createElement('small');
      sku.textContent = item.sku;
      const source = document.createElement('small');
      source.className = 'inventory-source';
      source.textContent = zohoControlled ? 'Zoho · U.S. fulfillment stock' : 'Local inventory control';
      identity.append(status, title, sku, source);

      const stats = document.createElement('dl');
      [
        ['Available', item.tracking ? item.available : '—'],
        ['Reserved', item.tracking ? item.reserved : '—'],
        ['Packs sold', item.unitsSold]
      ].forEach(([label, value]) => {
        const group = document.createElement('div');
        const term = document.createElement('dt');
        term.textContent = label;
        const description = document.createElement('dd');
        description.textContent = value;
        group.append(term, description);
        stats.append(group);
      });

      const controls = document.createElement('div');
      controls.className = 'inventory-controls';
      const stockLabel = document.createElement('label');
      const stockText = document.createElement('span');
      stockText.textContent = 'Stock on hand';
      const stock = document.createElement('input');
      stock.name = 'stockOnHand';
      stock.type = 'number';
      stock.min = '0';
      stock.max = '1000000';
      stock.step = '1';
      stock.placeholder = 'Not tracked';
      stock.value = item.tracking ? item.stockOnHand : '';
      stock.disabled = zohoControlled;
      stock.title = zohoControlled ? 'Update stock in Zoho Inventory and run a sync.' : '';
      stockLabel.append(stockText, stock);
      const reorderLabel = document.createElement('label');
      const reorderText = document.createElement('span');
      reorderText.textContent = 'Low-stock level';
      const reorder = document.createElement('input');
      reorder.name = 'reorderLevel';
      reorder.type = 'number';
      reorder.min = '0';
      reorder.max = '100000';
      reorder.step = '1';
      reorder.value = item.reorderLevel;
      reorderLabel.append(reorderText, reorder);
      const reasonLabel = document.createElement('label');
      const reasonText = document.createElement('span');
      reasonText.textContent = 'Adjustment note';
      const reason = document.createElement('input');
      reason.name = 'reason';
      reason.maxLength = 180;
      reason.placeholder = 'Physical count';
      reason.disabled = zohoControlled;
      reasonLabel.append(reasonText, reason);
      const button = document.createElement('button');
      button.type = 'submit';
      button.textContent = zohoControlled ? 'Save threshold' : 'Save stock';
      const formStatus = document.createElement('p');
      formStatus.className = 'inventory-status';
      formStatus.setAttribute('role', 'status');
      controls.append(stockLabel, reorderLabel, reasonLabel, button, formStatus);

      form.append(identity, stats, controls);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        button.disabled = true;
        formStatus.textContent = 'Saving…';
        formStatus.classList.remove('is-error');
        const stockValue = stock.value.trim();
        const body = {
          reorderLevel: Number(reorder.value),
          reason: reason.value.trim() || 'Physical inventory count'
        };
        if (!zohoControlled) body.stockOnHand = stockValue === '' ? null : Number(stockValue);
        try {
          await api(`/api/v1/admin/inventory/${encodeURIComponent(item.formatSlug)}`, { method: 'PATCH', body });
          await loadDashboard();
          setStatus(dashboardStatus, `${item.formatName} inventory was updated.`);
        } catch (error) {
          formStatus.textContent = error.message;
          formStatus.classList.add('is-error');
          button.disabled = false;
        }
      });
      list.append(form);
    });
  };

  const renderPayments = (items) => {
    const body = qs('[data-payment-body]');
    body.replaceChildren();
    if (!items.length) {
      const row = body.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 8;
      cell.textContent = 'No Stripe payment events have been recorded yet.';
      return;
    }
    items.forEach((item) => {
      const row = body.insertRow();
      addCells(row, [
        item.orderNumber || 'No order',
        [item.customer?.name, item.customer?.email].filter(Boolean).join(' · ') || '—',
        item.stripePaymentIntentId || '—',
        formatMoney(item.amount, item.currency),
        formatMoney(item.amountRefunded || 0, item.currency),
        formatMoney(Number.isInteger(item.amount) ? Math.max(0, item.amount - (item.amountRefunded || 0)) : null, item.currency)
      ]);
      addStatusCell(row, item.status);
      addCells(row, [formatDate(item.updatedAt)]);
    });
  };

  const renderOrders = (items) => {
    const body = qs('[data-order-body]');
    body.replaceChildren();
    if (!items.length) {
      const row = body.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 9;
      cell.textContent = 'No signed Stripe orders have arrived yet.';
      return;
    }
    items.forEach((item) => {
      const row = body.insertRow();
      addCells(row, [
        item.orderNumber,
        [item.customer?.name, item.customer?.email].filter(Boolean).join(' · ') || '—',
        item.formatName || formatNames[item.formatSlug] || item.sku || '—',
        item.quantity,
        formatMoney(item.amountSubtotal, item.currency),
        formatMoney(item.amountShipping || 0, item.currency),
        formatMoney(item.amountTotal, item.currency)
      ]);
      addStatusCell(row, item.status);
      addCells(row, [formatDate(item.createdAt)]);
    });
  };

  const renderWaitlist = (items) => {
    const body = qs('[data-waitlist-body]');
    body.replaceChildren();
    if (!items.length) {
      const row = body.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 7;
      cell.textContent = 'No one has joined the pre-launch list yet.';
      return;
    }
    items.forEach((item) => {
      const row = body.insertRow();
      addCells(row, [item.name, item.email, formatNames[item.preferredFormat] || item.preferredFormat, item.country || '—', formatDate(item.createdAt)]);
    });
  };

  const renderInquiries = (items) => {
    const list = qs('[data-inquiry-list]');
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No partner inquiries have arrived yet.';
      list.append(empty);
      return;
    }
    items.forEach((item) => {
      const card = document.createElement('article');
      card.className = 'inquiry-card';
      const identity = document.createElement('div');
      const type = document.createElement('span');
      type.className = 'inquiry-type';
      type.textContent = item.inquiryType;
      const name = document.createElement('h3');
      name.textContent = item.name;
      const contact = document.createElement('a');
      contact.href = `mailto:${item.email}`;
      contact.textContent = item.email;
      const organization = document.createElement('small');
      organization.textContent = [item.organization, item.phone].filter(Boolean).join(' · ') || 'Independent inquiry';
      identity.append(type, name, contact, document.createElement('br'), organization);
      const message = document.createElement('p');
      message.textContent = item.message;
      const date = document.createElement('small');
      date.className = 'inquiry-date';
      date.textContent = formatDate(item.createdAt);
      card.append(identity, message, date);
      list.append(card);
    });
  };

  const showStaffInvitation = (data) => {
    const panel = qs('[data-staff-invite]');
    const input = qs('[data-staff-invite-url]');
    input.value = data.invitationUrl;
    const delivery = data.delivery || { status: 'unknown' };
    qs('[data-staff-invite-delivery]').textContent = delivery.status === 'sent'
      ? `Emailed to ${data.user.email} · recovery link below`
      : `Email ${statusLabel(delivery.status)} · copy this link to recover`;
    qs('[data-staff-invite-expiry]').textContent = `Expires ${formatDate(data.expiresAt)}`;
    panel.hidden = false;
    input.focus();
    input.select();
  };

  const renderStaff = (users, roles) => {
    staffUsers = users;
    staffRoles = roles;
    const taskAssignee = qs('[data-admin-task-assignee]');
    const taskLocation = qs('[data-admin-task-location]');
    if (taskAssignee && taskLocation) populateTaskAssignees(taskAssignee, taskLocation.value, taskAssignee.value);
    const roleById = new Map(roles.map((role) => [role.id, role]));
    const roleSelect = qs('[data-staff-role]');
    const selectedRole = roleSelect.value;
    roleSelect.replaceChildren(new Option('Choose a role', ''));
    roles.forEach((role) => roleSelect.append(new Option(role.label, role.id)));
    roleSelect.value = selectedRole;

    const managerSelect = qs('[data-staff-manager]');
    const selectedManager = managerSelect.value;
    managerSelect.replaceChildren(new Option('No manager selected', ''));
    users.filter((user) => user.status === 'active').forEach((user) => {
      managerSelect.append(new Option(`${user.name} (${user.roleLabel})`, user.id));
    });
    managerSelect.value = selectedManager;

    qs('[data-staff-total]').textContent = `${users.length} employee${users.length === 1 ? '' : 's'}`;
    const body = qs('[data-staff-body]');
    body.replaceChildren();
    if (!users.length) {
      const row = body.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 5;
      cell.textContent = 'No employee accounts yet. Create the owner account first.';
      return;
    }

    users.forEach((user) => {
      const row = body.insertRow();
      const identity = row.insertCell();
      const name = document.createElement('strong');
      name.textContent = user.name;
      const email = document.createElement('a');
      email.href = `mailto:${user.email}`;
      email.textContent = user.email;
      const number = document.createElement('small');
      number.textContent = [user.employeeNumber, user.jobTitle].filter(Boolean).join(' · ');
      identity.append(name, email, number);

      const contactCell = row.insertCell();
      contactCell.className = 'staff-contact-cell';
      if (user.phone) {
        const phone = document.createElement('a');
        phone.href = `tel:${user.phone}`;
        phone.textContent = user.phone;
        contactCell.append(phone);
      }
      const waUrl = whatsappUrl(user.whatsappNumber, `Hello ${user.name}, this is a SEVEN ROOTS operations message.`);
      if (waUrl) {
        const whatsapp = document.createElement('a');
        whatsapp.href = waUrl;
        whatsapp.target = '_blank';
        whatsapp.rel = 'noopener';
        whatsapp.textContent = 'WhatsApp';
        contactCell.append(whatsapp);
      }
      if (!user.phone && !waUrl) contactCell.textContent = 'Not added';
      const editor = document.createElement('details');
      editor.className = 'staff-contact-editor';
      const editorSummary = document.createElement('summary');
      editorSummary.textContent = 'Edit contact';
      const editorForm = document.createElement('form');
      const titleInput = document.createElement('input');
      titleInput.value = user.jobTitle || '';
      titleInput.placeholder = 'Job title';
      titleInput.maxLength = 100;
      titleInput.setAttribute('aria-label', `Job title for ${user.name}`);
      const phoneInput = document.createElement('input');
      phoneInput.value = user.phone || '';
      phoneInput.placeholder = 'Phone';
      phoneInput.maxLength = 40;
      phoneInput.setAttribute('aria-label', `Phone number for ${user.name}`);
      const whatsappInput = document.createElement('input');
      whatsappInput.value = user.whatsappNumber || '';
      whatsappInput.placeholder = 'WhatsApp +country code';
      whatsappInput.maxLength = 40;
      whatsappInput.setAttribute('aria-label', `WhatsApp number for ${user.name}`);
      const contactSave = document.createElement('button');
      contactSave.type = 'submit';
      contactSave.textContent = 'Save contact';
      editorForm.append(titleInput, phoneInput, whatsappInput, contactSave);
      editorForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        contactSave.disabled = true;
        try {
          await api(`/api/v1/admin/staff/${encodeURIComponent(user.id)}`, {
            method: 'PATCH',
            body: { jobTitle: titleInput.value, phone: phoneInput.value, whatsappNumber: whatsappInput.value }
          });
          await loadDashboard();
          setStatus(qs('[data-staff-form-status]'), `${user.name}'s contact information was updated.`);
        } catch (error) {
          setStatus(qs('[data-staff-form-status]'), error.message, true);
          contactSave.disabled = false;
        }
      });
      editor.append(editorSummary, editorForm);
      contactCell.append(editor);

      const roleCell = row.insertCell();
      roleCell.textContent = roleById.get(user.role)?.label || user.roleLabel;
      const locationsCell = row.insertCell();
      locationsCell.textContent = user.locations.map((location) => location === 'us' ? 'U.S.' : 'Liberia').join(', ');
      addStatusCell(row, user.status);

      const deliveryCell = row.insertCell();
      deliveryCell.className = 'invitation-delivery';
      const delivery = user.invitationDelivery;
      const deliveryStatus = delivery?.usedAt ? 'accepted' : delivery?.status || 'unknown';
      const deliveryBadge = document.createElement('span');
      deliveryBadge.className = `order-status${statusIsAlert(deliveryStatus) ? ' is-alert' : ''}`;
      deliveryBadge.textContent = statusLabel(deliveryStatus);
      const deliveryDetail = document.createElement('small');
      deliveryDetail.textContent = delivery?.error || (delivery?.sentAt
        ? formatDate(delivery.sentAt)
        : delivery?.attemptedAt ? formatDate(delivery.attemptedAt) : 'No email attempt');
      deliveryCell.append(deliveryBadge, deliveryDetail);

      const actionsCell = row.insertCell();
      const actions = document.createElement('div');
      actions.className = 'staff-row-actions';
      const status = document.createElement('select');
      status.setAttribute('aria-label', `Access status for ${user.name}`);
      ['active', 'inactive'].forEach((value) => status.append(new Option(statusLabel(value), value)));
      status.value = user.status === 'invited' ? 'active' : user.status;
      const save = document.createElement('button');
      save.type = 'button';
      save.textContent = 'Save';
      save.addEventListener('click', async () => {
        save.disabled = true;
        try {
          await api(`/api/v1/admin/staff/${encodeURIComponent(user.id)}`, { method: 'PATCH', body: { status: status.value } });
          await loadDashboard();
          setStatus(qs('[data-staff-form-status]'), `${user.name}'s access was updated.`);
        } catch (error) {
          setStatus(qs('[data-staff-form-status]'), error.message, true);
        } finally { save.disabled = false; }
      });
      const invite = document.createElement('button');
      invite.type = 'button';
      invite.textContent = user.status === 'invited' ? 'Email new invite' : 'Email reset';
      invite.disabled = user.status === 'inactive';
      invite.addEventListener('click', async () => {
        invite.disabled = true;
        try {
          const data = await api(`/api/v1/admin/staff/${encodeURIComponent(user.id)}/invitations`, { method: 'POST' });
          showStaffInvitation(data);
          await loadDashboard();
          setStatus(qs('[data-staff-form-status]'), data.delivery?.status === 'sent'
            ? `A new activation link was emailed to ${data.user.email}.`
            : 'A new link was created, but email delivery needs attention.', data.delivery?.status !== 'sent');
        } catch (error) {
          setStatus(qs('[data-staff-form-status]'), error.message, true);
        } finally { invite.disabled = user.status === 'inactive'; }
      });
      actions.append(status, save, invite);
      actionsCell.append(actions);
    });
  };

  const loadDashboard = async () => {
    setStatus(dashboardStatus, 'Refreshing private commerce data…');
    const [summary, financialReport, zohoStatus, emailStatus, whatsappStatus, inventory, payments, orders, waitlist, inquiries, staff, roles, tasks] = await Promise.all([
      api('/api/v1/admin/summary'),
      api('/api/v1/admin/financial-report'),
      api('/api/v1/admin/zoho/status'),
      api('/api/v1/admin/email/status'),
      api('/api/v1/admin/whatsapp/status'),
      api('/api/v1/admin/inventory'),
      api('/api/v1/admin/payments?limit=500'),
      api('/api/v1/admin/orders?limit=500'),
      api('/api/v1/admin/waitlist?limit=500'),
      api('/api/v1/admin/inquiries?limit=500'),
      api('/api/v1/admin/staff'),
      api('/api/v1/admin/staff/roles'),
      api('/api/v1/admin/tasks?limit=500')
    ]);
    collections = { orders, payments, inventory, waitlist, inquiries };
    renderSummary(summary);
    renderFinancialReport(financialReport);
    renderZoho(zohoStatus);
    renderEmail(emailStatus);
    renderWhatsApp(whatsappStatus);
    renderInventory(inventory);
    renderPayments(payments);
    renderOrders(orders);
    renderWaitlist(waitlist);
    renderInquiries(inquiries);
    renderStaff(staff, roles);
    renderAdminTasks(tasks);
    setStatus(dashboardStatus, `Updated ${new Date().toLocaleTimeString()}.`);
  };

  const unlock = async () => {
    try {
      await loadDashboard();
      sessionStorage.setItem('seven-roots-admin-key', apiKey);
      loginView.hidden = true;
      dashboard.hidden = false;
      headerActions.hidden = false;
    } catch (error) {
      sessionStorage.removeItem('seven-roots-admin-key');
      setStatus(loginStatus, error.message, true);
      throw error;
    }
  };

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = qs('button[type="submit"]', loginForm);
    button.disabled = true;
    setStatus(loginStatus, 'Verifying private access…');
    apiKey = String(new FormData(loginForm).get('apiKey') || '').trim();
    try { await unlock(); } catch {} finally { button.disabled = false; }
  });

  qs('[data-refresh]').addEventListener('click', () => loadDashboard().catch((error) => setStatus(dashboardStatus, error.message, true)));

  const staffForm = qs('[data-staff-form]');
  const staffRoleSelect = qs('[data-staff-role]');
  const applyStaffRoleLocations = () => {
    const role = staffRoles.find((item) => item.id === staffRoleSelect.value);
    qsa('input[name="locations"]', staffForm).forEach((checkbox) => {
      const allowed = Boolean(role?.allowedLocations.includes(checkbox.value));
      checkbox.disabled = !allowed;
      checkbox.checked = Boolean(role?.defaultLocations.includes(checkbox.value));
    });
    if (role?.defaultLocations.length === 1) {
      staffForm.elements.country.value = role.defaultLocations[0] === 'liberia' ? 'Liberia' : 'United States';
    }
  };
  staffRoleSelect.addEventListener('change', applyStaffRoleLocations);

  staffForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = qs('button[type="submit"]', staffForm);
    const form = new FormData(staffForm);
    const locations = form.getAll('locations').map(String);
    button.disabled = true;
    setStatus(qs('[data-staff-form-status]'), 'Creating the employee account and emailing a secure invitation…');
    try {
      const data = await api('/api/v1/admin/staff', {
        method: 'POST',
        body: {
          name: form.get('name'),
          email: form.get('email'),
          jobTitle: form.get('jobTitle'),
          phone: form.get('phone'),
          whatsappNumber: form.get('whatsappNumber'),
          role: form.get('role'),
          country: form.get('country'),
          locations,
          managerId: form.get('managerId')
        }
      });
      staffForm.reset();
      showStaffInvitation(data);
      await loadDashboard();
      setStatus(qs('[data-staff-form-status]'), data.delivery?.status === 'sent'
        ? `${data.user.name} was added and the activation link was emailed to ${data.user.email}.`
        : `${data.user.name} was added, but the email was not delivered. Copy the recovery link and check email settings.`, data.delivery?.status !== 'sent');
    } catch (error) {
      const detail = Object.values(error.details || {})[0];
      setStatus(qs('[data-staff-form-status]'), detail || error.message, true);
    } finally { button.disabled = false; }
  });

  const adminTaskForm = qs('[data-admin-task-form]');
  const adminTaskLocation = qs('[data-admin-task-location]');
  const adminTaskAssignee = qs('[data-admin-task-assignee]');
  adminTaskLocation.addEventListener('change', () => populateTaskAssignees(adminTaskAssignee, adminTaskLocation.value));
  adminTaskForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = qs('button[type="submit"]', adminTaskForm);
    const form = new FormData(adminTaskForm);
    const evidenceRequirements = form.getAll('evidenceRequirements').map(String);
    const scopeFiles = form.getAll('scopeFiles').filter((file) => file instanceof File && file.size > 0);
    if (!evidenceRequirements.length) {
      setStatus(qs('[data-admin-task-status]'), 'Choose at least one completion evidence requirement.', true);
      return;
    }
    button.disabled = true;
    setStatus(qs('[data-admin-task-status]'), 'Creating and allocating the task…');
    try {
      const dueAtValue = String(form.get('dueAt') || '');
      const data = await api('/api/v1/admin/tasks', {
        method: 'POST',
        body: {
          title: form.get('title'),
          location: form.get('location'),
          type: form.get('type'),
          priority: form.get('priority'),
          assignedTo: form.get('assignedTo'),
          scopeOfWork: form.get('scopeOfWork'),
          evidenceRequirements,
          dueAt: dueAtValue ? new Date(dueAtValue).toISOString() : null
        }
      });
      const task = data.task || data;
      let uploaded = 0;
      for (const file of scopeFiles) {
        await uploadTaskFile(task.id, file);
        uploaded += 1;
      }
      adminTaskForm.reset();
      adminTaskLocation.value = 'liberia';
      populateTaskAssignees(adminTaskAssignee, 'liberia');
      await loadDashboard();
      setStatus(qs('[data-admin-task-status]'), `${task.title} was created${task.assignedTo ? ' and allocated' : ''}${uploaded ? ` with ${uploaded} work file${uploaded === 1 ? '' : 's'}` : ''}.`);
    } catch (error) {
      const detail = Object.values(error.details || {})[0];
      setStatus(qs('[data-admin-task-status]'), detail || error.message, true);
    } finally { button.disabled = false; }
  });

  qs('[data-copy-staff-invite]').addEventListener('click', async (event) => {
    const input = qs('[data-staff-invite-url]');
    try {
      await navigator.clipboard.writeText(input.value);
      event.currentTarget.textContent = 'Copied';
    } catch {
      input.focus();
      input.select();
      document.execCommand('copy');
      event.currentTarget.textContent = 'Copied';
    }
  });

  const runZohoAction = async (button, path, pendingMessage, successMessage) => {
    const connectorStatus = qs('[data-zoho-status]');
    button.disabled = true;
    setStatus(connectorStatus, pendingMessage);
    try {
      await api(path, { method: 'POST' });
      await loadDashboard();
      setStatus(connectorStatus, successMessage);
    } catch (error) {
      setStatus(connectorStatus, error.message, true);
      button.disabled = false;
    }
  };

  qs('[data-zoho-connect]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    setStatus(qs('[data-zoho-status]'), 'Preparing a restricted Zoho authorization…');
    try {
      const authorization = await api('/api/v1/admin/zoho/oauth/start', { method: 'POST' });
      window.location.assign(authorization.authorizationUrl);
    } catch (error) {
      setStatus(qs('[data-zoho-status]'), error.message, true);
      button.disabled = false;
    }
  });
  qs('[data-zoho-provision]').addEventListener('click', (event) => runZohoAction(
    event.currentTarget,
    '/api/v1/admin/zoho/provision',
    'Creating any missing storefront products and the dedicated online-store customer…',
    'Zoho products, warehouse mappings, and customer record are prepared.'
  ));

  qs('[data-zoho-test]').addEventListener('click', (event) => runZohoAction(
    event.currentTarget,
    '/api/v1/admin/zoho/test',
    'Testing Zoho authorization, locations, and SKU mappings…',
    'Zoho connection test completed.'
  ));
  qs('[data-zoho-sync]').addEventListener('click', (event) => runZohoAction(
    event.currentTarget,
    '/api/v1/admin/zoho/sync',
    'Synchronizing Liberia and U.S. stock…',
    'Zoho inventory synchronization completed.'
  ));
  qs('[data-zoho-orders-sync]').addEventListener('click', (event) => runZohoAction(
    event.currentTarget,
    '/api/v1/admin/zoho/orders/sync',
    'Sending paid Stripe orders to Zoho…',
    'Paid-order synchronization completed.'
  ));
  qs('[data-logout]').addEventListener('click', () => {
    apiKey = '';
    sessionStorage.removeItem('seven-roots-admin-key');
    dashboard.hidden = true;
    headerActions.hidden = true;
    loginView.hidden = false;
    loginForm.reset();
    setStatus(loginStatus, 'Studio locked.');
  });

  const csvCell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  qsa('[data-export]').forEach((button) => button.addEventListener('click', () => {
    const type = button.dataset.export;
    const rows = collections[type] || [];
    if (!rows.length) return;
    const keys = type === 'orders'
      ? ['orderNumber', 'customerName', 'customerEmail', 'formatName', 'sku', 'quantity', 'amountSubtotal', 'amountShipping', 'amountTax', 'amountTotal', 'refundedAmount', 'currency', 'status', 'stripeSessionId', 'stripePaymentIntentId', 'createdAt']
      : type === 'payments'
        ? ['orderNumber', 'customerName', 'customerEmail', 'stripePaymentIntentId', 'stripeChargeId', 'amount', 'amountRefunded', 'currency', 'status', 'livemode', 'lastEventType', 'createdAt', 'updatedAt']
        : type === 'waitlist'
          ? ['name', 'email', 'preferredFormat', 'country', 'status', 'createdAt']
          : ['name', 'email', 'phone', 'organization', 'inquiryType', 'message', 'status', 'createdAt'];
    const exportRows = ['orders', 'payments'].includes(type)
      ? rows.map((row) => ({ ...row, customerName: row.customer?.name, customerEmail: row.customer?.email }))
      : rows;
    const csv = [keys.join(','), ...exportRows.map((row) => keys.map((key) => csvCell(row[key])).join(','))].join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    link.download = `seven-roots-${type}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }));

  if (apiKey) unlock().catch(() => { loginView.hidden = false; });
})();
