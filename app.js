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
    if (status) status.textContent = name;
    if (mobile) mobile.textContent = name;
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

  const dialog = qs('[data-dialog]');
  const dialogForm = qs('[data-dialog-form]');
  const dialogContent = qs('[data-dialog-content]');
  const dialogSuccess = qs('[data-dialog-success]');
  const successCopy = qs('[data-success-copy]');
  qsa('[data-open-ritual]').forEach((button) => button.addEventListener('click', () => {
    const radio = qs(`input[name="pack"][value="${selectedPack}"]`);
    if (radio) radio.checked = true;
    dialogContent.hidden = false; dialogSuccess.hidden = true;
    if (typeof dialog.showModal === 'function') dialog.showModal();
  }));
  dialogForm?.addEventListener('submit', (event) => {
    const submitter = event.submitter;
    if (submitter?.value === 'cancel' || submitter?.value === 'close') return;
    event.preventDefault();
    const value = new FormData(dialogForm).get('pack') || selectedPack;
    updatePack(String(value));
    dialogContent.hidden = true; dialogSuccess.hidden = false;
    successCopy.textContent = `${value} is your selected pre-launch format.`;
  });
  dialog?.addEventListener('click', (event) => {
    const rect = dialog.getBoundingClientRect();
    const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
    if (outside) dialog.close();
  });
})();
