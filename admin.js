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
  let collections = { waitlist: [], inquiries: [] };

  const setStatus = (element, message, isError = false) => {
    element.textContent = message;
    element.classList.toggle('is-error', isError);
  };

  const api = async (path) => {
    const response = await fetch(path, { headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || 'The private API could not be reached.');
    return payload.data;
  };

  const formatDate = (value) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

  const renderSummary = (summary) => {
    qs('[data-total-waitlist]').textContent = summary.waitlistTotal;
    qs('[data-total-inquiries]').textContent = summary.inquiryTotal;
    const entries = Object.entries(summary.formatInterest || {}).sort((a, b) => b[1] - a[1]);
    qs('[data-leading-format]').textContent = entries.length ? formatNames[entries[0][0]] || entries[0][0] : 'No signal yet';
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
      [item.name, item.email, formatNames[item.preferredFormat] || item.preferredFormat, item.country || '—', formatDate(item.createdAt)]
        .forEach((value) => { const cell = row.insertCell(); cell.textContent = value; });
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

  const loadDashboard = async () => {
    setStatus(dashboardStatus, 'Refreshing private data…');
    const [summary, waitlist, inquiries] = await Promise.all([
      api('/api/v1/admin/summary'), api('/api/v1/admin/waitlist?limit=500'), api('/api/v1/admin/inquiries?limit=500')
    ]);
    collections = { waitlist, inquiries };
    renderSummary(summary);
    renderWaitlist(waitlist);
    renderInquiries(inquiries);
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
    apiKey = new FormData(loginForm).get('apiKey').trim();
    try { await unlock(); } catch {} finally { button.disabled = false; }
  });

  qs('[data-refresh]').addEventListener('click', () => loadDashboard().catch((error) => setStatus(dashboardStatus, error.message, true)));
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
    const rows = collections[type];
    if (!rows.length) return;
    const keys = type === 'waitlist'
      ? ['name', 'email', 'preferredFormat', 'country', 'status', 'createdAt']
      : ['name', 'email', 'phone', 'organization', 'inquiryType', 'message', 'status', 'createdAt'];
    const csv = [keys.join(','), ...rows.map((row) => keys.map((key) => csvCell(row[key])).join(','))].join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    link.download = `seven-roots-${type}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }));

  if (apiKey) unlock().catch(() => { loginView.hidden = false; });
})();
