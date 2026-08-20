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
  let apiKey = sessionStorage.getItem('seven-roots-admin-key') || '';
  let collections = { orders: [], payments: [], inventory: [], waitlist: [], inquiries: [] };
  let currentZohoStatus = { configured: false, enabled: false, inventoryAuthority: false, mappings: [] };
  let staffUsers = [];
  let staffRoles = [];

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
  const statusIsAlert = (value) => !['paid', 'pending', 'in_stock', 'not_tracked', 'active', 'ready', 'synced'].includes(value);

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
      cell.colSpan = 5;
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
      cell.colSpan = 5;
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
    qs('[data-staff-invite-expiry]').textContent = `Expires ${formatDate(data.expiresAt)}`;
    panel.hidden = false;
    input.focus();
    input.select();
  };

  const renderStaff = (users, roles) => {
    staffUsers = users;
    staffRoles = roles;
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
      number.textContent = user.employeeNumber;
      identity.append(name, email, number);

      const roleCell = row.insertCell();
      roleCell.textContent = roleById.get(user.role)?.label || user.roleLabel;
      const locationsCell = row.insertCell();
      locationsCell.textContent = user.locations.map((location) => location === 'us' ? 'U.S.' : 'Liberia').join(', ');
      addStatusCell(row, user.status);

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
      invite.textContent = user.status === 'invited' ? 'New link' : 'Reset access';
      invite.disabled = user.status === 'inactive';
      invite.addEventListener('click', async () => {
        invite.disabled = true;
        try {
          const data = await api(`/api/v1/admin/staff/${encodeURIComponent(user.id)}/invitations`, { method: 'POST' });
          showStaffInvitation(data);
          await loadDashboard();
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
    const [summary, financialReport, zohoStatus, inventory, payments, orders, waitlist, inquiries, staff, roles] = await Promise.all([
      api('/api/v1/admin/summary'),
      api('/api/v1/admin/financial-report'),
      api('/api/v1/admin/zoho/status'),
      api('/api/v1/admin/inventory'),
      api('/api/v1/admin/payments?limit=500'),
      api('/api/v1/admin/orders?limit=500'),
      api('/api/v1/admin/waitlist?limit=500'),
      api('/api/v1/admin/inquiries?limit=500'),
      api('/api/v1/admin/staff'),
      api('/api/v1/admin/staff/roles')
    ]);
    collections = { orders, payments, inventory, waitlist, inquiries };
    renderSummary(summary);
    renderFinancialReport(financialReport);
    renderZoho(zohoStatus);
    renderInventory(inventory);
    renderPayments(payments);
    renderOrders(orders);
    renderWaitlist(waitlist);
    renderInquiries(inquiries);
    renderStaff(staff, roles);
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
    setStatus(qs('[data-staff-form-status]'), 'Creating a secure one-time invitation...');
    try {
      const data = await api('/api/v1/admin/staff', {
        method: 'POST',
        body: {
          name: form.get('name'),
          email: form.get('email'),
          role: form.get('role'),
          country: form.get('country'),
          locations,
          managerId: form.get('managerId')
        }
      });
      staffForm.reset();
      showStaffInvitation(data);
      await loadDashboard();
      setStatus(qs('[data-staff-form-status]'), `${data.user.name} was added. Copy the invitation link now.`);
    } catch (error) {
      const detail = Object.values(error.details || {})[0];
      setStatus(qs('[data-staff-form-status]'), detail || error.message, true);
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
