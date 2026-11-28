(() => {
  const background = document.querySelector('.ascii-background');
  const wordmark = document.querySelector('.wordmark');
  const tryLink = document.querySelector('.try-link');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  // The workspace sends first-time visitors here; this marks that they came through the front door.
  const enter = () => { try { sessionStorage.setItem('everwhere-entered', '1'); } catch { /* Storage may be unavailable. */ } };
  document.querySelectorAll('a[href^="/app"]').forEach(link => link.addEventListener('click', enter));

  const resetTilt = () => {
    wordmark.classList.remove('is-tilted');
    wordmark.style.removeProperty('--tilt-x');
    wordmark.style.removeProperty('--tilt-y');
    wordmark.style.removeProperty('--fan-x');
  };
  const tilt = ({ clientX, clientY, pointerType }) => {
    if (pointerType === 'touch' || reducedMotion.matches) return;
    const { left, top, width, height } = wordmark.getBoundingClientRect();
    const x = (clientX - left) / width - 0.5;
    const y = (clientY - top) / height - 0.5;
    wordmark.style.setProperty('--tilt-x', `${12 - y * 48}deg`);
    wordmark.style.setProperty('--tilt-y', `${-15 + x * 56}deg`);
    wordmark.style.setProperty('--fan-x', `${x * 44}px`);
    wordmark.classList.add('is-tilted');
  };
  wordmark.addEventListener('pointerenter', tilt);
  wordmark.addEventListener('pointermove', tilt);
  wordmark.addEventListener('pointerleave', resetTilt);
  wordmark.addEventListener('pointercancel', resetTilt);
  window.addEventListener('blur', resetTilt);
  reducedMotion.addEventListener('change', resetTilt);

  tryLink.addEventListener('pointermove', ({ clientX, clientY, pointerType }) => {
    if (pointerType === 'touch' || reducedMotion.matches) return;
    const { left, top } = tryLink.getBoundingClientRect();
    tryLink.style.setProperty('--glint-x', `${clientX - left}px`);
    tryLink.style.setProperty('--glint-y', `${clientY - top}px`);
  });

  const photoCanvas = background.querySelector('.ascii-photo');
  const context = photoCanvas.getContext('2d');
  const trailCanvas = background.querySelector('.ascii-trail');
  const trailContext = trailCanvas.getContext('2d');
  const sampler = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!sampler || !context) return;

  const sources = ['photos/lake.webp', 'photos/ocean.webp', 'photos/stars.webp', 'photos/desert.webp'];
  const glyphs = ' .,:;-~+=!iltfrxvuznXYTLCJ0OZQwm#MW&8%B@$';
  const trail = [];
  const trailLifetime = 620;
  let trailFrame = 0;
  let width = background.clientWidth;
  let height = background.clientHeight;
  let scale = Math.min(window.devicePixelRatio, 2);
  let photo;

  function sizeCanvas(canvas, context) {
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
  }

  let dissolving = false;
  function paint() {
    if (dissolving || !photo || !width || !height) return;

    sizeCanvas(photoCanvas, context);
    const fontSize = width < 680 ? 7 : 8;
    context.font = `${fontSize}px ui-monospace, monospace`;
    context.textBaseline = 'middle';
    context.fillStyle = '#fff';

    const cellHeight = fontSize * 1.18;
    const cellWidth = context.measureText('M').width;
    const columns = Math.ceil(width / cellWidth);
    const rows = Math.ceil(height / cellHeight);
    sampler.canvas.width = columns;
    sampler.canvas.height = rows;

    const cover = Math.max(width / photo.naturalWidth, height / photo.naturalHeight);
    const cropWidth = width / cover;
    const cropHeight = height / cover;
    sampler.drawImage(photo, (photo.naturalWidth - cropWidth) / 2, (photo.naturalHeight - cropHeight) / 2,
      cropWidth, cropHeight, 0, 0, columns, rows);
    const colors = sampler.getImageData(0, 0, columns, rows);
    const pixels = colors.data;

    for (let row = 0; row < rows; row++) {
      let line = '';
      for (let column = 0; column < columns; column++) {
        const offset = (row * columns + column) * 4;
        const red = pixels[offset];
        const green = pixels[offset + 1];
        const blue = pixels[offset + 2];
        const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
        line += glyphs[Math.round(luminance ** 0.9 * (glyphs.length - 1))];
        // Lift dark colors so sparse glyphs remain visible against the backdrop.
        const lift = 0.76 + 66 / Math.max(32, red, green, blue);
        pixels[offset] = red * lift;
        pixels[offset + 1] = green * lift;
        pixels[offset + 2] = blue * lift;
      }
      context.fillText(line, 0, (row + 0.5) * cellHeight);
    }

    // Mask the enlarged color grid with the text, so each cell keeps its own color.
    sampler.putImageData(colors, 0, 0);
    context.save();
    context.globalCompositeOperation = 'source-in';
    context.imageSmoothingEnabled = false;
    context.drawImage(sampler.canvas, 0, 0, columns * cellWidth, rows * cellHeight);
    context.restore();
  }

  function drawTrail(time) {
    trailFrame = 0;
    trailContext.clearRect(0, 0, width, height);
    while (trail.length && time - trail[0].time >= trailLifetime) trail.shift();
    if (!trail.length) return;

    for (const { x, y, time: started } of trail) {
      const life = Math.max(0, 1 - (time - started) / trailLifetime);
      const radius = 26 + 57 * life;
      const glow = trailContext.createRadialGradient(x, y, 0, x, y, radius);
      glow.addColorStop(0, `rgb(185 252 255 / ${life * 0.95})`);
      glow.addColorStop(0.45, `rgb(112 166 255 / ${life * 0.52})`);
      glow.addColorStop(1, 'rgb(121 168 255 / 0)');
      trailContext.fillStyle = glow;
      trailContext.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }

    // Keep the moving light inside the shapes of the photo's ASCII characters.
    trailContext.save();
    trailContext.globalCompositeOperation = 'destination-in';
    trailContext.drawImage(photoCanvas, 0, 0, width, height);

    const tip = trail.at(-1);
    const remaining = Math.max(0, 1 - (time - tip.time) / trailLifetime);
    const halo = trailContext.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, 100);
    halo.addColorStop(0, `rgb(56 138 255 / ${remaining * 0.24})`);
    halo.addColorStop(1, 'rgb(56 138 255 / 0)');
    trailContext.globalCompositeOperation = 'destination-over';
    trailContext.fillStyle = halo;
    trailContext.fillRect(tip.x - 100, tip.y - 100, 200, 200);
    trailContext.restore();
    trailFrame = requestAnimationFrame(drawTrail);
  }

  function clearTrail() {
    if (!trailContext) return;
    cancelAnimationFrame(trailFrame);
    trailFrame = 0;
    trail.length = 0;
    trailContext.clearRect(0, 0, width, height);
  }

  reducedMotion.addEventListener('change', clearTrail);
  document.addEventListener('visibilitychange', clearTrail);
  window.addEventListener('blur', clearTrail);
  window.addEventListener('pointermove', ({ clientX, clientY, pointerType }) => {
    if (!trailContext || pointerType === 'touch' || !photo || reducedMotion.matches || document.hidden) return;

    const last = trail.at(-1);
    if (last && Math.hypot(clientX - last.x, clientY - last.y) < 8) return;
    trail.push({ x: clientX, y: clientY, time: performance.now() });
    if (trail.length > 16) trail.shift();
    if (!trailFrame) trailFrame = requestAnimationFrame(drawTrail);
  }, { passive: true });
  if (trailContext) sizeCanvas(trailCanvas, trailContext);
  new ResizeObserver(() => {
    const nextWidth = background.clientWidth;
    const nextHeight = background.clientHeight;
    const nextScale = Math.min(window.devicePixelRatio, 2);
    if (nextWidth === width && nextHeight === height && nextScale === scale) return;
    width = nextWidth;
    height = nextHeight;
    scale = nextScale;
    clearTrail();
    if (trailContext) sizeCanvas(trailCanvas, trailContext);
    paint();
  }).observe(background);

  // "Try it out": the characters drift away from the click, nearest first, before the workspace opens.
  function dissolve(originX, originY, done) {
    dissolving = true;
    clearTrail();
    const snapshot = document.createElement('canvas');
    snapshot.width = photoCanvas.width;
    snapshot.height = photoCanvas.height;
    snapshot.getContext('2d').drawImage(photoCanvas, 0, 0);
    const size = 14;
    const reach = Math.hypot(Math.max(originX, width - originX), Math.max(originY, height - originY));
    const tiles = [];
    for (let y = 0; y < height; y += size) {
      for (let x = 0; x < width; x += size) {
        const dx = x + size / 2 - originX;
        const dy = y + size / 2 - originY;
        const angle = Math.atan2(dy, dx) + (Math.random() - 0.5) * 1.1;
        tiles.push({ x, y, delay: Math.hypot(dx, dy) / reach * 900 + Math.random() * 320,
          driftX: Math.cos(angle) * (50 + Math.random() * 150), driftY: Math.sin(angle) * (50 + Math.random() * 150) - 40 - Math.random() * 60,
          spin: (Math.random() - 0.5) * 1.6 });
      }
    }
    const life = 1250;
    const total = 900 + 320 + life;
    let started = 0;
    const frame = now => {
      started ||= now;
      const elapsed = now - started;
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.globalCompositeOperation = 'source-over';
      context.clearRect(0, 0, width, height);
      for (const tile of tiles) {
        const progress = (elapsed - tile.delay) / life;
        if (progress >= 1) continue;
        if (progress <= 0) {
          context.globalAlpha = 1;
          context.drawImage(snapshot, tile.x * scale, tile.y * scale, size * scale, size * scale, tile.x, tile.y, size, size);
          continue;
        }
        const eased = 1 - (1 - progress) ** 3;
        const shrink = 1 - eased * 0.55;
        context.globalAlpha = (1 - progress) ** 1.6;
        context.save();
        context.translate(tile.x + size / 2 + tile.driftX * eased, tile.y + size / 2 + tile.driftY * eased);
        context.rotate(tile.spin * eased);
        context.drawImage(snapshot, tile.x * scale, tile.y * scale, size * scale, size * scale, -size * shrink / 2, -size * shrink / 2, size * shrink, size * shrink);
        context.restore();
      }
      context.globalAlpha = 1;
      if (elapsed < total) requestAnimationFrame(frame);
      else done();
    };
    requestAnimationFrame(frame);
  }
  tryLink.addEventListener('click', event => {
    if (dissolving) { event.preventDefault(); return; }
    if (reducedMotion.matches || !photo || event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
    event.preventDefault();
    const box = tryLink.getBoundingClientRect();
    document.body.classList.add('is-leaving');
    dissolve(event.clientX || box.left + box.width / 2, event.clientY || box.top + box.height / 2, () => location.assign(tryLink.href));
  });
  // Coming back with the browser's Back button restores a frozen page; redraw it.
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

  // Choose one landscape per load, with fallbacks if a photo cannot be decoded.
  for (let i = sources.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [sources[i], sources[j]] = [sources[j], sources[i]];
  }
  async function loadPhoto() {
    for (const source of sources) {
      const candidate = new Image();
      candidate.src = source;
      try {
        await candidate.decode();
      } catch {
        continue;
      }
      photo = candidate;
      paint();
      return;
    }
  }
  loadPhoto();
})();
