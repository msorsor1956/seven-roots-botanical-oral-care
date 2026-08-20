(() => {
  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

  const header = qs('[data-header]');
  const menuButton = qs('[data-menu-button]');
  const nav = qs('[data-nav]');

  const setMenu = (open) => {
    menuButton?.setAttribute('aria-expanded', String(open));
    nav?.classList.toggle('is-open', open);
    document.body.classList.toggle('menu-open', open);
    const label = qs('.sr-only', menuButton);
    if (label) label.textContent = open ? 'Close menu' : 'Open menu';
  };

  menuButton?.addEventListener('click', () => setMenu(menuButton.getAttribute('aria-expanded') !== 'true'));
  qsa('a', nav).forEach((link) => link.addEventListener('click', () => setMenu(false)));
  const hero = qs('#top');
  if (header && hero && 'IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      header.classList.toggle('is-scrolled', !entry.isIntersecting);
    }, { rootMargin: '-20px 0px 0px', threshold: 0 }).observe(hero);
  }

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduceMotion && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: .11 });
    qsa('.reveal').forEach((el) => observer.observe(el));
  } else {
    qsa('.reveal').forEach((el) => el.classList.add('is-visible'));
  }

  const tilt = qs('[data-tilt]');
  if (tilt && !reduceMotion && window.matchMedia('(pointer: fine)').matches) {
    tilt.addEventListener('pointermove', (event) => {
      const box = tilt.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - .5;
      const y = (event.clientY - box.top) / box.height - .5;
      tilt.style.transform = `perspective(1100px) rotateY(${x * 4}deg) rotateX(${y * -4}deg)`;
    });
    tilt.addEventListener('pointerleave', () => { tilt.style.transform = ''; });
  }

  const packNames = ['Travel Sleeve', 'Daily Ritual', 'Family Reserve'];
  const packSlugs = { 'Travel Sleeve': 'travel-sleeve', 'Daily Ritual': 'daily-ritual', 'Family Reserve': 'family-reserve' };
  const priceByPack = new Map();
  const storageKey = 'seven-roots-selected-format';
  let selectedPack = 'Daily Ritual';
  try {
    const storedPack = window.localStorage.getItem(storageKey);
    if (packNames.includes(storedPack)) selectedPack = storedPack;
  } catch {}
  const updatePack = (name) => {
    if (!packNames.includes(name)) return;
    selectedPack = name;
    qsa('[data-pack]').forEach((card) => {
      const selected = card.dataset.pack === name;
      card.classList.toggle('is-selected', selected);
      const button = qs('.pack-select', card);
      if (button) button.innerHTML = selected ? 'Selected <span aria-hidden="true">✓</span>' : 'Select format <span aria-hidden="true">→</span>';
    });
    const status = qs('[data-selected-pack]');
    const mobile = qs('[data-mobile-pack]');
    const mobilePrice = qs('[data-mobile-price]');
    if (status) status.textContent = name;
    if (mobile) mobile.textContent = name;
    if (mobilePrice) mobilePrice.textContent = priceByPack.get(name) || 'Checking price…';
    const radio = qs(`input[name="pack"][value="${name}"]`);
    if (radio) radio.checked = true;
    try { window.localStorage.setItem(storageKey, name); } catch {}
  };

  qsa('[data-pack]').forEach((card) => {
    card.addEventListener('click', () => updatePack(card.dataset.pack));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); updatePack(card.dataset.pack); }
    });
  });
  updatePack(selectedPack);

  const componentData = {
    sleeve: { number: '01', title: 'Outer sleeve', copy: 'Matte paperboard with low-ink foil detail.', x: '25%', y: '16%' },
    tray: { number: '02', title: 'Kraft tray', copy: 'A molded or folded fiber structure with no plastic insert.', x: '37%', y: '39%' },
    wraps: { number: '03', title: 'Individual wraps', copy: 'Breathable plant-cellulose sleeves carry lot and best-before codes.', x: '56%', y: '59%' },
    tube: { number: '04', title: 'Travel tube', copy: 'Reusable protection with ventilation for a rinsed, air-dried stick.', x: '67%', y: '76%' },
    guide: { number: '05', title: 'Ritual guide', copy: 'Clear technique, care, storage, and safety instructions.', x: '27%', y: '81%' }
  };
  const stage = qs('[data-stage]');
  const stageLabel = qs('.stage-label', stage);
  qsa('[data-component]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.component;
      const data = componentData[key];
      qsa('[data-component]').forEach((item) => {
        const active = item === button;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      stage?.style.setProperty('--fx', data.x);
      stage?.style.setProperty('--fy', data.y);
      if (stageLabel) stageLabel.innerHTML = `<span>${data.number}</span><p><b>${data.title}</b><small>${data.copy}</small></p>`;
    });
  });

  qsa('[role="tab"]', qs('[data-tabs]')).forEach((tab, index, tabs) => {
    tab.addEventListener('click', () => activateTab(tab, tabs));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : (index - 1 + tabs.length) % tabs.length;
      tabs[next].focus(); activateTab(tabs[next], tabs);
    });
  });
  function activateTab(tab, tabs) {
    const key = tab.dataset.tab;
    tabs.forEach((item) => item.setAttribute('aria-selected', String(item === tab)));
    qsa('[data-panel]').forEach((panel) => { panel.hidden = panel.dataset.panel !== key; });
  }

  const copyStatus = qs('[data-copy-status]');
  qsa('[data-copy]').forEach((button) => button.addEventListener('click', async () => {
    const value = button.dataset.copy;
    try { await navigator.clipboard.writeText(value); copyStatus.textContent = `${value} copied to clipboard.`; }
    catch { copyStatus.textContent = `Copy manually: ${value}.`; }
  }));

  const apiBase = qs('meta[name="seven-roots-api-base"]')?.content.replace(/\/$/u, '') || '';
  const getJson = async (path) => {
    const response = await fetch(`${apiBase}${path}`, { headers: { accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || 'The request could not be completed.');
    return payload;
  };
  const postJson = async (path, body) => {
    const response = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error?.message || 'The request could not be completed.');
      error.details = payload.error?.details || {};
      throw error;
    }
    return payload;
  };

  const formatMoney = ({ unitAmount, currency }) => new Intl.NumberFormat(undefined, {
    style: 'currency', currency, maximumFractionDigits: unitAmount % 100 ? 2 : 0
  }).format(unitAmount / 100);

  let checkoutReady = false;
  const checkoutWasCancelled = new URL(window.location.href).searchParams.get('checkout') === 'cancelled';
  const checkoutStatus = qs('[data-checkout-status]');
  const checkoutSubmit = qs('[data-checkout-submit]');
  const loadCatalog = async () => {
    try {
      const payload = await getJson('/api/v1/formats');
      let pricedFormats = 0;
      payload.data.forEach((format) => {
        const display = format.pricing ? formatMoney(format.pricing) : 'Checkout pending';
        const name = packNames.find((packName) => packSlugs[packName] === format.slug);
        if (name) priceByPack.set(name, display);
        qsa(`[data-price-for="${format.slug}"], [data-dialog-price="${format.slug}"]`).forEach((element) => {
          element.textContent = display;
        });
        if (format.pricing) pricedFormats += 1;
      });
      checkoutReady = payload.meta?.pricingStatus === 'available' && pricedFormats === packNames.length;
      checkoutSubmit.disabled = !checkoutReady;
      setStatus(
        checkoutStatus,
        checkoutReady
          ? (checkoutWasCancelled ? 'Checkout was canceled. No payment was made; your selected format is still saved.' : 'Secure checkout is available.')
          : 'Checkout is awaiting final Stripe product configuration.',
        checkoutReady && !checkoutWasCancelled ? '' : 'error'
      );
      updatePack(selectedPack);
    } catch {
      qsa('[data-price-for], [data-dialog-price]').forEach((element) => { element.textContent = 'Temporarily unavailable'; });
      checkoutSubmit.disabled = true;
      setStatus(checkoutStatus, 'Prices could not be loaded. Please try again shortly.', 'error');
    }
  };

  const clearFormErrors = (form) => {
    qsa('[aria-invalid="true"]', form).forEach((field) => field.removeAttribute('aria-invalid'));
    qsa('.field-error', form).forEach((error) => error.remove());
    qs('.consent-row', form)?.classList.remove('is-invalid');
  };

  const showFormErrors = (form, errors = {}) => {
    Object.entries(errors).forEach(([name, message]) => {
      if (name === 'consent') {
        qs('.consent-row', form)?.classList.add('is-invalid');
        return;
      }
      const field = form.elements.namedItem(name);
      if (!(field instanceof HTMLElement)) return;
      field.setAttribute('aria-invalid', 'true');
      const error = document.createElement('span');
      error.className = 'field-error';
      error.textContent = String(message);
      field.closest('label')?.append(error);
    });
  };

  const setSubmitState = (form, busy) => {
    const submit = qs('button[type="submit"]', form);
    if (!submit) return;
    submit.disabled = busy;
    if (!submit.dataset.label) submit.dataset.label = submit.textContent;
    submit.textContent = busy ? 'Sending…' : submit.dataset.label;
  };

  const setStatus = (status, message, kind = '') => {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('is-error', kind === 'error');
    status.classList.toggle('is-success', kind === 'success');
  };

  const dialog = qs('[data-dialog]');
  const checkoutForm = qs('[data-checkout-form]');
  const dialogContent = qs('[data-dialog-content]');
  qsa('[data-open-ritual]').forEach((button) => button.addEventListener('click', () => {
    const radio = qs(`input[name="pack"][value="${selectedPack}"]`);
    if (radio) radio.checked = true;
    dialogContent.hidden = false;
    if (typeof dialog.showModal === 'function') dialog.showModal();
  }));
  qs('[data-dialog-close]')?.addEventListener('click', () => dialog.close());
  checkoutForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(checkoutForm);
    const value = formData.get('pack') || selectedPack;
    updatePack(String(value));
    if (!checkoutReady) {
      setStatus(checkoutStatus, 'Secure checkout is not available yet. Please try again shortly.', 'error');
      return;
    }
    checkoutSubmit.disabled = true;
    checkoutSubmit.textContent = 'Preparing secure checkout…';
    setStatus(checkoutStatus, 'Creating a protected Stripe Checkout Session…');
    try {
      const payload = await postJson('/api/v1/checkout/sessions', {
        formatSlug: packSlugs[String(value)],
        quantity: Number(formData.get('quantity'))
      });
      window.location.assign(payload.data.url);
    } catch (error) {
      setStatus(checkoutStatus, `${error.message} No payment was made.`, 'error');
      checkoutSubmit.disabled = false;
      checkoutSubmit.textContent = 'Continue to secure checkout';
    }
  });
  dialog?.addEventListener('click', (event) => {
    const rect = dialog.getBoundingClientRect();
    const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
    if (outside) dialog.close();
  });

  const currentUrl = new URL(window.location.href);
  if (checkoutWasCancelled) {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    setStatus(checkoutStatus, 'Checkout was canceled. No payment was made; your selected format is still saved.', 'error');
    currentUrl.searchParams.delete('checkout');
    window.history.replaceState({}, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
  }

  const inquiryForm = qs('[data-inquiry-form]');
  const inquiryStatus = qs('[data-inquiry-status]');
  inquiryForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFormErrors(inquiryForm);
    const formData = new FormData(inquiryForm);
    setSubmitState(inquiryForm, true);
    setStatus(inquiryStatus, 'Sending your inquiry…');
    try {
      const payload = await postJson('/api/v1/inquiries', {
        name: formData.get('name'),
        email: formData.get('email'),
        phone: formData.get('phone'),
        organization: formData.get('organization'),
        inquiryType: formData.get('inquiryType'),
        message: formData.get('message'),
        website: formData.get('website'),
        consent: formData.get('consent') === 'on'
      });
      inquiryForm.reset();
      setStatus(inquiryStatus, payload.message || 'Your inquiry was received.', 'success');
    } catch (error) {
      showFormErrors(inquiryForm, error.details);
      setStatus(inquiryStatus, error.message, 'error');
    } finally {
      setSubmitState(inquiryForm, false);
    }
  });

  loadCatalog();
})();
