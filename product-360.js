(() => {
  const root = document.querySelector('[data-360-viewer]');
  if (!root) return;

  const stage = root.querySelector('[data-3d-stage]');
  const canvas = root.querySelector('[data-3d-canvas]');
  const loading = root.querySelector('[data-3d-loading]');
  const status = root.querySelector('[data-3d-status]');
  const wordmark = root.querySelector('[data-3d-wordmark]');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;

  const productData = {
    travel: {
      sku: 'SR-T01 · Trial and travel', title: 'Travel Sleeve', count: '1 stick',
      structure: 'Slim paper sleeve', use: 'Travel and sampling', mark: '1 STICK',
      copy: 'One authenticated, hygienically wrapped chewing stick in a slim paper sleeve for trial, hospitality, travel, and sampling.',
      parts: ['sleeve', 'band', 'stick']
    },
    ritual: {
      sku: 'SR-R05 · Signature format', title: 'Daily Ritual', count: '5 sticks',
      structure: 'Drawer carton', use: 'Daily ritual', mark: '5 STICKS',
      copy: 'Five hygienically wrapped chewing sticks in a pull-drawer carton, paired with a reusable ventilated travel tube and a clear ritual guide.',
      parts: ['sleeve', 'band', 'tray', 'wraps', 'tube', 'guide']
    },
    family: {
      sku: 'SR-F12 · Household format', title: 'Family Reserve', count: '12 sticks',
      structure: 'Recloseable carton', use: 'Household and repeat use', mark: '12 STICKS',
      copy: 'Twelve individually wrapped sticks in a recloseable paperboard format designed for households, repeat customers, and careful stock rotation.',
      parts: ['sleeve', 'band', 'wraps']
    }
  };

  const partData = {
    sleeve: ['01', 'Outer sleeve', 'Forest-green uncoated paperboard protects the pack and carries the primary brand story. Final stock weight, barrier performance, and recyclability require supplier validation.'],
    band: ['02', 'Terracotta band', 'A restrained color band differentiates formats and origin-led editions. Its line motif should remain decorative and must not copy sacred or restricted cultural symbols.'],
    tray: ['03', 'Kraft drawer', 'A folded or molded recycled-fiber tray organizes the five-stick format without a plastic insert. Compression strength and transit performance must be engineered.'],
    wraps: ['04', 'Individually wrapped sticks', 'Breathable plant-cellulose sleeves support hygienic handling and carry botanical name, origin, lot, packing, and best-before information. Barrier and shelf-life performance must be validated.'],
    tube: ['05', 'Reusable travel tube', 'A dark-green, food-safe tube protects one rinsed and air-dried stick between uses. Ventilation is essential; users should never seal a wet stick in an airtight container.'],
    guide: ['06', 'Ritual guide', 'The fiber-ivory guide explains preparation, light brushing technique, rinsing, air-drying, replacement, supervision, irritation warnings, and the role of professional dental care.'],
    stick: ['07', 'Authenticated chewing stick', 'The botanical name, plant part, source region, supplier, harvest window, lot identity, microbial screen, contaminant testing, and storage conditions belong to the product record.']
  };

  const state = {
    variant: 'ritual', selected: 'sleeve', yaw: -.52, pitch: -.23, zoom: 1,
    explode: 0, explodeTarget: 0, autoRotate: !reduceMotion && !coarsePointer,
    dragging: false, lastX: 0, lastY: 0, velocity: 0, visible: true,
    width: 0, height: 0, frame: 0, lastTime: 0, needsDraw: true
  };

  let ctx;
  try { ctx = canvas.getContext('2d', { alpha: true, desynchronized: true }); }
  catch { ctx = null; }

  const failToFallback = (message) => {
    stage.classList.add('is-fallback');
    loading.classList.add('is-ready');
    status.textContent = message || 'Interactive 3D is unavailable. The static exploded product view is shown with complete descriptions.';
  };

  if (!ctx) {
    failToFallback();
    return;
  }

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const lerp = (a, b, t) => a + (b - a) * t;

  function hexToRgb(hex) {
    const value = hex.replace('#', '');
    return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
  }

  function shade(hex, amount) {
    const [r, g, b] = hexToRgb(hex);
    return `rgb(${Math.round(clamp(r * amount, 0, 255))},${Math.round(clamp(g * amount, 0, 255))},${Math.round(clamp(b * amount, 0, 255))})`;
  }

  function shifted(position, offset) {
    return [
      position[0] + offset[0] * state.explode,
      position[1] + offset[1] * state.explode,
      position[2] + offset[2] * state.explode
    ];
  }

  function addBox(scene, key, position, size, color, offset = [0, 0, 0], options = {}) {
    const p = shifted(position, offset);
    const [hx, hy, hz] = size.map(v => v / 2);
    const vertices = [
      [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
      [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]
    ].map(v => [v[0] + p[0], v[1] + p[1], v[2] + p[2]]);
    const faces = [
      [0, 1, 2, 3], [4, 7, 6, 5], [0, 3, 7, 4],
      [1, 5, 6, 2], [3, 2, 6, 7], [0, 4, 5, 1]
    ];
    scene.primitives.push({ key, vertices, faces, color, kind: 'box', options });
    return p;
  }

  function addCylinder(scene, key, position, axis, length, radius, color, offset = [0, 0, 0], segments = 12, options = {}) {
    const p = shifted(position, offset);
    const vertices = [];
    for (let end = -1; end <= 1; end += 2) {
      for (let i = 0; i < segments; i++) {
        const angle = i / segments * Math.PI * 2;
        const a = Math.cos(angle) * radius;
        const b = Math.sin(angle) * radius;
        if (axis === 'x') vertices.push([p[0] + end * length / 2, p[1] + a, p[2] + b]);
        else if (axis === 'z') vertices.push([p[0] + a, p[1] + b, p[2] + end * length / 2]);
        else vertices.push([p[0] + a, p[1] + end * length / 2, p[2] + b]);
      }
    }
    const faces = [];
    for (let i = 0; i < segments; i++) faces.push([i, (i + 1) % segments, segments + (i + 1) % segments, segments + i]);
    faces.push([...Array(segments).keys()].reverse());
    faces.push([...Array(segments).keys()].map(i => i + segments));
    scene.primitives.push({ key, vertices, faces, color, kind: 'cylinder', options });
    return p;
  }

  function addStick(scene, key, position, offset = [0, 0, 0], wrapped = false, axis = 'y', length = 3.1) {
    const bark = wrapped ? '#CBBDA4' : '#6E4930';
    addCylinder(scene, key, position, axis, length, .20, bark, offset, 10, { translucent: wrapped });
    const tipPosition = [...position];
    const tipShift = length / 2 + .18;
    if (axis === 'x') tipPosition[0] -= tipShift;
    else if (axis === 'z') tipPosition[2] -= tipShift;
    else tipPosition[1] -= tipShift;
    addCylinder(scene, key, tipPosition, axis, .36, .18, '#E2C98F', offset, 10);
  }

  function buildScene() {
    const scene = { primitives: [], labelAnchor: [0, .65, .72], wordmarkVisible: true };
    if (state.variant === 'travel') {
      addBox(scene, 'sleeve', [-.75, 0, 0], [1.35, 5.2, 1.15], '#173D32', [-1.3, .1, -.8]);
      addBox(scene, 'band', [-.75, -1.63, .02], [1.39, .78, 1.19], '#C86C3A', [-1.3, -.5, -.5]);
      addBox(scene, 'sleeve', [-.75, .72, .59], [.78, .08, .045], '#B48A4A', [-1.3, .1, -.8]);
      addStick(scene, 'stick', [1.25, -.05, .15], [1.45, -.15, 1.0], false, 'y', 4.35);
      scene.labelAnchor = [-.75, .18, .62];
    } else if (state.variant === 'family') {
      addBox(scene, 'sleeve', [0, 0, 0], [6.1, 4.2, 1.55], '#173D32', [0, .95, -1.2]);
      addBox(scene, 'band', [0, -.7, .03], [6.14, .78, 1.59], '#C86C3A', [0, .1, -.5]);
      addBox(scene, 'sleeve', [0, .66, .8], [2.9, .09, .04], '#B48A4A', [0, .95, -1.2]);
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 6; col++) {
          addStick(scene, 'wraps', [-2.25 + col * .9, -.15 + row * .43, -.1], [0, -.45 + row * .25, 2.2 + row * .35], true, 'y', 2.9);
        }
      }
      scene.labelAnchor = [0, .35, .82];
    } else {
      addBox(scene, 'sleeve', [0, .72, -.45], [5.55, 3.55, 1.05], '#173D32', [0, 1.1, -1.25]);
      addBox(scene, 'band', [0, -.05, -.42], [5.59, .54, 1.1], '#C86C3A', [0, .45, -.75]);
      addBox(scene, 'sleeve', [0, .78, .1], [2.65, .08, .04], '#B48A4A', [0, 1.1, -1.25]);
      addBox(scene, 'tray', [0, -1.28, .44], [5.18, .56, 1.18], '#A97845', [0, -1.0, .75]);
      addBox(scene, 'tray', [0, -1.03, .92], [5.12, .12, .22], '#C59A65', [0, -1.0, .75]);
      for (let i = 0; i < 5; i++) addStick(scene, 'wraps', [-1.7 + i * .85, -.15, .62], [(i - 2) * .14, -.15, 1.65], true, 'y', 2.55);
      addCylinder(scene, 'tube', [3.45, -.15, .05], 'y', 3.55, .39, '#234D40', [1.5, -.45, .95], 16);
      addCylinder(scene, 'tube', [3.45, -1.72, .05], 'y', .18, .41, '#B48A4A', [1.5, -.45, .95], 16);
      addBox(scene, 'guide', [-3.35, -1.55, .25], [1.55, .08, 1.05], '#E8D7B9', [-1.45, -.85, 1.05]);
      scene.labelAnchor = [0, .52, .12];
    }
    return scene;
  }

  function transform(point) {
    const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw);
    const cp = Math.cos(state.pitch), sp = Math.sin(state.pitch);
    const x1 = point[0] * cy + point[2] * sy;
    const z1 = -point[0] * sy + point[2] * cy;
    const y2 = point[1] * cp - z1 * sp;
    const z2 = point[1] * sp + z1 * cp;
    return [x1, y2, z2];
  }

  function project(point) {
    const transformed = transform(point);
    const camera = 10.8;
    const focal = Math.min(state.width, state.height) * 1.31 * state.zoom;
    const scale = focal / Math.max(3.5, camera - transformed[2]);
    return [state.width / 2 + transformed[0] * scale, state.height * .48 - transformed[1] * scale, transformed[2]];
  }

  function render() {
    if (!state.width || !state.height || !state.visible) return;
    ctx.clearRect(0, 0, state.width, state.height);
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    ctx.beginPath();
    ctx.ellipse(state.width / 2, state.height * .73, Math.min(260, state.width * .32) * state.zoom, Math.min(46, state.height * .065) * state.zoom, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const scene = buildScene();
    const renderFaces = [];
    scene.primitives.forEach((primitive, primitiveIndex) => {
      const points = primitive.vertices.map(project);
      primitive.faces.forEach((face, faceIndex) => {
        const poly = face.map(index => points[index]);
        const depth = poly.reduce((sum, point) => sum + point[2], 0) / poly.length;
        const lightFactor = primitive.kind === 'cylinder' ? .72 + (faceIndex % 5) * .07 : [.66, 1.08, .78, .92, 1.16, .58][faceIndex] || .85;
        renderFaces.push({ primitive, primitiveIndex, faceIndex, poly, depth, color: shade(primitive.color, lightFactor) });
      });
    });
    renderFaces.sort((a, b) => a.depth - b.depth || a.primitiveIndex - b.primitiveIndex);

    renderFaces.forEach(face => {
      const points = face.poly;
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
      ctx.closePath();
      ctx.globalAlpha = face.primitive.options.translucent ? .86 : 1;
      ctx.fillStyle = face.color;
      ctx.fill();
      ctx.globalAlpha = 1;
      const selected = face.primitive.key === state.selected;
      ctx.strokeStyle = selected ? '#E68A55' : 'rgba(18,25,20,.34)';
      ctx.lineWidth = selected ? 2.1 : .72;
      ctx.stroke();
    });

    const anchor = project(scene.labelAnchor);
    const frontVisible = Math.cos(state.yaw) > .12;
    wordmark.style.left = `${anchor[0]}px`;
    wordmark.style.top = `${anchor[1]}px`;
    wordmark.style.opacity = frontVisible ? '1' : '0';
    wordmark.style.transform = `translate(-50%,-50%) scale(${clamp(state.zoom * (10.8 / (10.8 - anchor[2])), .72, 1.35)})`;
  }

  function requestDraw() {
    state.needsDraw = true;
    if (!state.frame && state.visible) state.frame = requestAnimationFrame(tick);
  }

  function tick(time) {
    state.frame = 0;
    if (!state.visible) return;
    const delta = state.lastTime ? Math.min(40, time - state.lastTime) : 16;
    state.lastTime = time;
    let continuous = false;

    if (!reduceMotion && Math.abs(state.explodeTarget - state.explode) > .002) {
      state.explode = lerp(state.explode, state.explodeTarget, .14);
      continuous = true;
    } else state.explode = state.explodeTarget;

    if (state.autoRotate && !state.dragging && !reduceMotion) {
      state.yaw += delta * .00022;
      continuous = true;
    }
    if (!state.dragging && Math.abs(state.velocity) > .0002 && !reduceMotion) {
      state.yaw += state.velocity;
      state.velocity *= .91;
      continuous = true;
    }

    if (state.needsDraw || continuous) render();
    state.needsDraw = false;
    if (continuous) state.frame = requestAnimationFrame(tick);
  }

  function resize() {
    const rect = stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.width = Math.max(280, Math.round(rect.width));
    state.height = Math.max(390, Math.round(rect.height));
    canvas.width = Math.round(state.width * dpr);
    canvas.height = Math.round(state.height * dpr);
    canvas.style.width = `${state.width}px`;
    canvas.style.height = `${state.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    requestDraw();
  }

  function setAutoRotate(enabled) {
    state.autoRotate = enabled && !reduceMotion;
    const button = root.querySelector('[data-3d-action="spin"]');
    button.setAttribute('aria-pressed', String(state.autoRotate));
    button.textContent = state.autoRotate ? 'Pause rotation' : 'Auto rotate';
    requestDraw();
  }

  function selectPart(key, announce = true) {
    if (!partData[key]) return;
    state.selected = key;
    root.querySelectorAll('[data-3d-part]').forEach(button => button.setAttribute('aria-pressed', String(button.getAttribute('data-3d-part') === key)));
    const [number, title, copy] = partData[key];
    root.querySelector('[data-3d-part-number]').textContent = number;
    root.querySelector('[data-3d-part-title]').textContent = title;
    root.querySelector('[data-3d-part-copy]').textContent = copy;
    if (announce) status.textContent = `${title} selected. ${copy}`;
    requestDraw();
  }

  function setVariant(key) {
    const data = productData[key];
    if (!data) return;
    state.variant = key;
    state.explodeTarget = 0;
    state.explode = reduceMotion ? 0 : state.explode;
    root.querySelectorAll('[data-3d-variant]').forEach(button => button.setAttribute('aria-pressed', String(button.getAttribute('data-3d-variant') === key)));
    root.querySelector('[data-3d-sku]').textContent = data.sku;
    root.querySelector('[data-3d-title]').textContent = data.title;
    root.querySelector('[data-3d-copy]').textContent = data.copy;
    root.querySelector('[data-3d-count]').textContent = data.count;
    root.querySelector('[data-3d-structure]').textContent = data.structure;
    root.querySelector('[data-3d-use]').textContent = data.use;
    wordmark.querySelector('small').textContent = data.mark;
    root.querySelectorAll('[data-3d-part]').forEach(button => { button.hidden = !data.parts.includes(button.getAttribute('data-3d-part')); });
    const explodeButton = root.querySelector('[data-3d-action="explode"]');
    explodeButton.setAttribute('aria-pressed', 'false');
    explodeButton.textContent = 'Explode';
    selectPart(data.parts[0], false);
    canvas.setAttribute('aria-label', `Interactive 3D model of the SEVEN ROOTS ${data.title} package. Drag to rotate. Use arrow keys to rotate, plus and minus to zoom, E to explode, and Home to reset.`);
    status.textContent = `${data.title} 3D model selected.`;
    requestDraw();
  }

  function resetView() {
    state.yaw = -.52; state.pitch = -.23; state.zoom = 1; state.velocity = 0;
    state.explodeTarget = 0;
    root.querySelector('[data-3d-action="explode"]').setAttribute('aria-pressed', 'false');
    root.querySelector('[data-3d-action="explode"]').textContent = 'Explode';
    status.textContent = '3D view reset to the front three-quarter angle.';
    requestDraw();
  }

  canvas.addEventListener('pointerdown', event => {
    state.dragging = true; state.lastX = event.clientX; state.lastY = event.clientY; state.velocity = 0;
    setAutoRotate(false); canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!state.dragging) return;
    const dx = event.clientX - state.lastX, dy = event.clientY - state.lastY;
    state.yaw += dx * .012;
    state.pitch = clamp(state.pitch + dy * .007, -.72, .44);
    state.velocity = dx * .0025;
    state.lastX = event.clientX; state.lastY = event.clientY;
    requestDraw();
  });
  const endDrag = event => {
    if (!state.dragging) return;
    state.dragging = false;
    try { canvas.releasePointerCapture(event.pointerId); } catch {}
    requestDraw();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    state.zoom = clamp(state.zoom - Math.sign(event.deltaY) * .08, .72, 1.38);
    setAutoRotate(false); status.textContent = `3D view zoom ${Math.round(state.zoom * 100)} percent.`; requestDraw();
  }, { passive: false });

  canvas.addEventListener('keydown', event => {
    let handled = true;
    if (event.key === 'ArrowLeft') state.yaw -= .13;
    else if (event.key === 'ArrowRight') state.yaw += .13;
    else if (event.key === 'ArrowUp') state.pitch = clamp(state.pitch - .09, -.72, .44);
    else if (event.key === 'ArrowDown') state.pitch = clamp(state.pitch + .09, -.72, .44);
    else if (event.key === '+' || event.key === '=') state.zoom = clamp(state.zoom + .08, .72, 1.38);
    else if (event.key === '-' || event.key === '_') state.zoom = clamp(state.zoom - .08, .72, 1.38);
    else if (event.key.toLowerCase() === 'e') root.querySelector('[data-3d-action="explode"]').click();
    else if (event.key === 'Home') resetView();
    else handled = false;
    if (handled) { event.preventDefault(); setAutoRotate(false); requestDraw(); }
  });

  root.querySelectorAll('[data-3d-variant]').forEach(button => button.addEventListener('click', () => setVariant(button.getAttribute('data-3d-variant'))));
  root.querySelectorAll('[data-3d-part]').forEach(button => button.addEventListener('click', () => selectPart(button.getAttribute('data-3d-part'))));
  root.querySelectorAll('[data-3d-action]').forEach(button => button.addEventListener('click', () => {
    const action = button.getAttribute('data-3d-action');
    if (action === 'zoom-in') { state.zoom = clamp(state.zoom + .1, .72, 1.38); status.textContent = `3D view zoom ${Math.round(state.zoom * 100)} percent.`; }
    else if (action === 'zoom-out') { state.zoom = clamp(state.zoom - .1, .72, 1.38); status.textContent = `3D view zoom ${Math.round(state.zoom * 100)} percent.`; }
    else if (action === 'reset') resetView();
    else if (action === 'spin') setAutoRotate(!state.autoRotate);
    else if (action === 'explode') {
      state.explodeTarget = state.explodeTarget ? 0 : 1;
      if (reduceMotion) state.explode = state.explodeTarget;
      button.setAttribute('aria-pressed', String(Boolean(state.explodeTarget)));
      button.textContent = state.explodeTarget ? 'Assemble' : 'Explode';
      status.textContent = state.explodeTarget ? 'Product components separated into an exploded view.' : 'Product components reassembled.';
    }
    requestDraw();
  }));

  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(stage);
  else window.addEventListener('resize', resize, { passive: true });

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      state.visible = entries[0].isIntersecting;
      if (state.visible) { state.lastTime = 0; requestDraw(); }
    }, { rootMargin: '180px 0px' }).observe(stage);
  }

  try {
    resize();
    setAutoRotate(state.autoRotate);
    setVariant('ritual');
    render();
    loading.classList.add('is-ready');
    status.textContent = 'Daily Ritual 3D model ready. Drag or use arrow keys to rotate.';
  } catch (error) {
    console.error('SEVEN ROOTS 3D viewer:', error);
    failToFallback();
  }
})();
