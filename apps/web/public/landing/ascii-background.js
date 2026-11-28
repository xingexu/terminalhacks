(() => {
  const background = document.querySelector('.ascii-background');
  const wordmark = document.querySelector('.wordmark');
  const tryLink = document.querySelector('.try-link');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

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

  const sources = ['photos/lake.webp', 'photos/ocean.webp', 'photos/stars.webp', 'photos/desert.webp'];
  const glyphs = ' .,:;-~+=!iltfrxvuznXYTLCJ0OZQwm#MW&8%B@$';
  const trail = [];
  const trailLifetime = 620;
  const scatterDuration = 1080;
  let trailFrame = 0;
  let width = background.clientWidth;
  let height = background.clientHeight;
  let scale = Math.min(window.devicePixelRatio, 2);
  let photo;
  let glyphWidth;
  let glyphHeight;
  let exitFrame = 0;
  let exitTimer = 0;
  let destination;
  let scatterCanvas;
  let scatterGL;
  let startGlyphScatter;
  let workspaceEntered = false;

  function sizeCanvas(canvas, context) {
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
  }

  function paint() {
    if (!photo || !width || !height) return;

    sizeCanvas(photoCanvas, context);
    const fontSize = width < 680 ? 7 : 8;
    context.font = `${fontSize}px ui-monospace, monospace`;
    context.textBaseline = 'middle';
    context.fillStyle = '#fff';

    const cellHeight = fontSize * 1.18;
    const cellWidth = context.measureText('M').width;
    glyphWidth = cellWidth;
    glyphHeight = cellHeight;
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
  function pointerTrail({ clientX, clientY, pointerType }) {
    if (!trailContext || document.documentElement.dataset.leaving || pointerType === 'touch' || !photo || reducedMotion.matches || document.hidden) return;

    const last = trail.at(-1);
    if (last && Math.hypot(clientX - last.x, clientY - last.y) < 8) return;
    trail.push({ x: clientX, y: clientY, time: performance.now() });
    if (trail.length > 16) trail.shift();
    if (!trailFrame) trailFrame = requestAnimationFrame(drawTrail);
  }
  window.addEventListener('pointermove', pointerTrail, { passive: true });
  if (trailContext) sizeCanvas(trailCanvas, trailContext);
  const backgroundObserver = new ResizeObserver(() => {
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
  });
  backgroundObserver.observe(background);

  // Each instance carries one original cell from the painted, full-resolution canvas.
  function glyphScatter(gl) {
    function shader(type, source) {
      const result = gl.createShader(type);
      gl.shaderSource(result, source);
      gl.compileShader(result);
      return result;
    }
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, `#version 300 es
      in vec2 corner;
      uniform vec2 viewport, cell, origin;
      uniform int columns;
      uniform float progress;
      out vec2 uv;
      void main() {
        vec2 grid = vec2(gl_InstanceID % columns, gl_InstanceID / columns);
        vec2 start = grid * cell;
        vec2 extent = min(cell, viewport - start);
        vec2 center = start + extent * .5;
        vec2 ray = center - origin;
        float spread = length(viewport);
        float seed = fract(sin(dot(grid, vec2(12.9898, 78.233))) * 43758.5453);
        float delay = .18 * length(ray) / spread + .02 * seed;
        float t = clamp((progress - delay) / (1.0 - delay), 0.0, 1.0);
        float motion = smoothstep(0.0, 1.0, t);
        float angle = (length(ray) < .01 ? seed * 6.283 : atan(ray.y, ray.x)) + (seed - .5) * .38;
        vec2 direction = vec2(cos(angle), sin(angle));
        vec2 toEdge = mix(center, viewport - center, step(vec2(0), direction));
        vec2 crossing = toEdge / max(abs(direction), vec2(.0001));
        float travel = min(crossing.x, crossing.y) + length(cell) + spread * (.12 + .14 * seed);
        float spin = (seed - .5) * 1.15 * motion;
        vec2 offset = (corner - .5) * extent;
        vec2 pos = center + direction * travel * motion
          + mat2(cos(spin), sin(spin), -sin(spin), cos(spin)) * offset;
        uv = (start + corner * extent) / viewport;
        gl_Position = vec4(pos / viewport * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
      }`));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      uniform sampler2D artwork;
      in vec2 uv;
      out vec4 pixel;
      void main() { pixel = texture(artwork, uv); }`));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    gl.useProgram(program);
    const corner = gl.getAttribLocation(program, 'corner');
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const progress = gl.getUniformLocation(program, 'progress');
    return (originX, originY) => {
      gl.canvas.width = photoCanvas.width;
      gl.canvas.height = photoCanvas.height;
      gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, photoCanvas);
      const columns = Math.ceil(width / glyphWidth);
      const count = columns * Math.ceil(height / glyphHeight);
      gl.uniform1i(gl.getUniformLocation(program, 'columns'), columns);
      gl.uniform2f(gl.getUniformLocation(program, 'viewport'), width, height);
      gl.uniform2f(gl.getUniformLocation(program, 'cell'), glyphWidth, glyphHeight);
      gl.uniform2f(gl.getUniformLocation(program, 'origin'), originX, originY);
      return t => {
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform1f(progress, t);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      };
    };
  }

  // Prepare the shader before activation. Only the final artwork upload depends on the click.
  function prepareScatter() {
    if (workspaceEntered || scatterCanvas || reducedMotion.matches || document.hidden) return;
    scatterCanvas = makeSurface(1, 1);
    scatterGL = scatterCanvas.getContext('webgl2', { antialias: false, depth: false, stencil: false });
    if (scatterGL) startGlyphScatter = glyphScatter(scatterGL);
  }
  tryLink.addEventListener('pointerenter', prepareScatter);
  tryLink.addEventListener('focus', prepareScatter);
  if (window.requestIdleCallback) window.requestIdleCallback(prepareScatter, { timeout: 1800 });
  // With 2D rendering, group adjacent glyphs to bound the draw calls on large displays.
  function canvasScatter(canvas, originX, originY) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const group = Math.max(1, Math.ceil(Math.sqrt(width * height / (glyphWidth * glyphHeight * 2200))));
    const stepX = glyphWidth * group, stepY = glyphHeight * group;
    const spread = Math.hypot(width, height);
    const fragments = [];
    for (let y = 0; y < height; y += stepY) {
      for (let x = 0; x < width; x += stepX) {
        const w = Math.min(width - x, stepX), h = Math.min(height - y, stepY);
        const dx = x + w / 2 - originX, dy = y + h / 2 - originY;
        const seed = Math.random();
        const angle = (dx || dy ? Math.atan2(dy, dx) : seed * Math.PI * 2) + (seed - .5) * .38;
        const vx = Math.cos(angle), vy = Math.sin(angle);
        const cx = x + w / 2, cy = y + h / 2;
        const edgeX = (vx >= 0 ? width - cx : cx) / Math.max(.0001, Math.abs(vx));
        const edgeY = (vy >= 0 ? height - cy : cy) / Math.max(.0001, Math.abs(vy));
        const travel = Math.min(edgeX, edgeY) + Math.hypot(w, h) + spread * (.12 + .14 * seed);
        fragments.push({ x, y, w, h, dx: vx * travel, dy: vy * travel,
          delay: .18 * Math.hypot(dx, dy) / spread + .02 * seed });
      }
    }
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    return progress => {
      ctx.clearRect(0, 0, width, height);
      for (const p of fragments) {
        const t = Math.max(0, (progress - p.delay) / (1 - p.delay));
        const motion = t * t * (3 - 2 * t);
        ctx.drawImage(photoCanvas, p.x * scale, p.y * scale, p.w * scale, p.h * scale,
          p.x + p.dx * motion, p.y + p.dy * motion, p.w, p.h);
      }
    };
  }

  function makeSurface(pixelWidth = photoCanvas.width, pixelHeight = photoCanvas.height) {
    const surface = document.createElement('canvas');
    surface.className = 'ascii-scatter';
    surface.width = pixelWidth;
    surface.height = pixelHeight;
    return surface;
  }

  function navigate() {
    if (!destination) return;
    const href = destination;
    destination = null;
    clearTimeout(exitTimer);
    cancelAnimationFrame(exitFrame);
    const enter = new CustomEvent('everwhere:enter-workspace', { cancelable: true, detail: { href } });
    if (window.dispatchEvent(enter)) {
      location.assign(href);
    } else {
      workspaceEntered = true;
      clearTrail();
      window.removeEventListener('pointermove', pointerTrail);
      backgroundObserver.disconnect();
      scatterGL?.getExtension('WEBGL_lose_context')?.loseContext();
      scatterGL = null;
      startGlyphScatter = null;
      scatterCanvas?.remove();
      scatterCanvas = null;
      photo = null;
      for (const surface of [photoCanvas, trailCanvas, sampler?.canvas]) {
        if (surface) surface.width = surface.height = 0;
      }
    }
  }

  tryLink.addEventListener('click', event => {
    const link = event.currentTarget;
    if (workspaceEntered || link.origin !== location.origin || link.pathname !== '/app' || link.search !== '?tour=0' ||
      link.target && link.target !== '_self' || event.defaultPrevented || event.button !== 0 ||
      event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    if (document.documentElement.dataset.leaving) return;
    destination = link.href;
    document.documentElement.dataset.leaving = 'true';
    if (!photo || reducedMotion.matches) return navigate();
    exitTimer = setTimeout(navigate, scatterDuration + 250);
    const bounds = link.getBoundingClientRect();
    const x = event.detail ? event.clientX : bounds.left + bounds.width / 2;
    const y = event.detail ? event.clientY : bounds.top + bounds.height / 2;
    clearTrail();
    prepareScatter();
    let draw = scatterGL && !scatterGL.isContextLost() && startGlyphScatter?.(x, y);
    if (!draw) {
      if (scatterGL) {
        scatterGL.getExtension('WEBGL_lose_context')?.loseContext();
        scatterGL = null;
      }
      scatterCanvas = makeSurface();
      draw = canvasScatter(scatterCanvas, x, y);
    }
    if (!draw) return navigate();
    background.append(scatterCanvas);
    draw(0);
    clearTimeout(exitTimer);
    exitTimer = setTimeout(navigate, scatterDuration + 250);
    let started;
    function tick(now) {
      started ??= now;
      const progress = Math.min(1, (now - started) / scatterDuration);
      draw(progress);
      if (progress < 1) exitFrame = requestAnimationFrame(tick);
      else navigate();
    }
    exitFrame = requestAnimationFrame(tick);
  });
  reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) navigate(); });
  window.addEventListener('pagehide', () => {
    clearTimeout(exitTimer);
    cancelAnimationFrame(exitFrame);
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted || workspaceEntered) return;
    scatterGL?.getExtension('WEBGL_lose_context')?.loseContext();
    scatterGL = null;
    startGlyphScatter = null;
    scatterCanvas?.remove();
    scatterCanvas = null;
    destination = null;
    delete document.documentElement.dataset.leaving;
    paint();
  });
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
      if (workspaceEntered) return;
      photo = candidate;
      paint();
      return;
    }
  }
  if (sampler && context) loadPhoto();
})();
