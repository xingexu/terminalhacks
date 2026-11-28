import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

// Same ramp as the landing page, darkest to brightest.
const glyphs = ' .,:;-~+=!iltfrxvuznXYTLCJ0OZQwm#MW&8%B@$';
const face = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const images = new Map<string, Promise<HTMLImageElement>>();
let sampler: CanvasRenderingContext2D | null | undefined;

function load(url: string) {
  let pending = images.get(url);
  if (!pending) {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    pending = image.decode().then(() => image);
    pending.catch(() => images.delete(url));
    if (images.size >= 24) {
      const first = images.keys().next().value;
      if (first !== undefined) images.delete(first);
    }
    images.set(url, pending);
  }
  return pending;
}

function paint(canvas: HTMLCanvasElement, image: HTMLImageElement, focusY: number) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const context = canvas.getContext('2d');
  sampler ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!context || !sampler || !width || !height || !image.naturalWidth) return false;

  const scale = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  context.setTransform(scale, 0, 0, scale, 0, 0);
  const size = width < 420 ? 6 : width < 900 ? 7 : 8;
  context.font = size + 'px ' + face;
  context.textBaseline = 'middle';
  context.fillStyle = '#fff';

  const cellHeight = size * 1.18;
  const cellWidth = context.measureText('M').width || size * 0.6;
  const columns = Math.ceil(width / cellWidth);
  const rows = Math.ceil(height / cellHeight);
  sampler.canvas.width = columns;
  sampler.canvas.height = rows;

  // Crop like object-fit: cover, so the characters line up with the photo behind them.
  const cover = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const cropWidth = width / cover;
  const cropHeight = height / cover;
  sampler.drawImage(image, (image.naturalWidth - cropWidth) / 2, (image.naturalHeight - cropHeight) * focusY,
    cropWidth, cropHeight, 0, 0, columns, rows);
  const cells = sampler.getImageData(0, 0, columns, rows);
  const pixels = cells.data;

  const light = new Float32Array(columns * rows);
  for (let i = 0; i < light.length; i++) {
    light[i] = (0.2126 * pixels[i * 4] + 0.7152 * pixels[i * 4 + 1] + 0.0722 * pixels[i * 4 + 2]) / 255;
  }
  // Stretch between the 2nd and 98th percentile so flat or hazy photos still separate into shapes,
  // but never by more than 4x.
  const sorted = Float32Array.from(light).sort();
  const low = sorted[Math.floor(sorted.length * 0.02)];
  const range = Math.max(sorted[Math.floor(sorted.length * 0.98)] - low, 0.25);

  for (let row = 0; row < rows; row++) {
    let line = '';
    for (let column = 0; column < columns; column++) {
      const index = row * columns + column;
      const linear = Math.min(1, Math.max(0, (light[index] - low) / range));
      // An S-curve keeps the midtones apart; without color, tone has to carry the picture.
      const value = linear * linear * (3 - 2 * linear);
      line += glyphs[Math.round(value * (glyphs.length - 1))];
      // Each cell also keeps a gray level, lifted so sparse glyphs in the shadows stay visible.
      const tone = Math.round(255 * (0.16 + 0.84 * value));
      pixels[index * 4] = pixels[index * 4 + 1] = pixels[index * 4 + 2] = tone;
      pixels[index * 4 + 3] = 255;
    }
    context.fillText(line, 0, (row + 0.5) * cellHeight);
  }

  sampler.putImageData(cells, 0, 0);
  context.globalCompositeOperation = 'source-in';
  context.imageSmoothingEnabled = false;
  context.drawImage(sampler.canvas, 0, 0, columns * cellWidth, rows * cellHeight);
  context.globalCompositeOperation = 'source-over';
  return true;
}

/**
 * Draws a photo as monochrome ASCII, sized to its box. Place it directly before the photo's <img>:
 * the stylesheet hides that image once the characters are ready, and leaves it visible if they never are.
 */
export function AsciiImage({ src, focusY = 0.5, className = '' }: { src: string; focusY?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let image: HTMLImageElement | undefined;
    let frame = 0;
    let cancelled = false;
    canvas.dataset.state = 'loading';
    const draw = () => {
      if (!image) return;
      try {
        if (paint(canvas, image, focusY)) canvas.dataset.state = 'ready';
      } catch {
        canvas.dataset.state = 'failed';
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    load(src).then(loaded => {
      if (cancelled) return;
      image = loaded;
      schedule();
    }, () => { if (!cancelled) canvas.dataset.state = 'failed'; });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [src, focusY]);
  return <canvas ref={ref} className={'ascii-image ' + className} aria-hidden="true" />;
}

export const art = {
  mark: String.raw`
 \|/
--*--
 /|\ `,
  universe: String.raw`
     .            *        .
  *       .-''''''-.
        .'    .     '.        *
   .   /   .     *    \   .
       |      (o)      |
  *    \   *      .    /
        '.     .     .'    .
     .    '-......-'
  .            *          *   `,
  compass: String.raw`
        .-'''''''-.
      .'     N     '.
     /       |       \
    |   W ---+--- E   |
     \       |       /
      '.     S     .'
        '-.......-'       `,
  film: String.raw`
 .------------------------.
 | [] [] [] [] [] [] [] []|
 |  .------------------.  |
 |  |        |\        |  |
 |  |        | >       |  |
 |  |        |/        |  |
 |  '------------------'  |
 | [] [] [] [] [] [] [] []|
 '------------------------'`,
  photo: String.raw`
 .------------------------.
 |   *              /\    |
 |        /\       /  \   |
 |       /  \  /\ /    \  |
 |   /\ /    \/  \      \ |
 |  /  \          \      \|
 |~~~~~~~~~~~~~~~~~~~~~~~~|
 '------------------------'`,
  book: String.raw`
 .------------. .------------.
 | ~~~~~~~~~~ | | ~~~~~~~~~~ |
 | ~~~~~~~    | | ~~~~~~~~   |
 | ~~~~~~~~~  | | ~~~~~      |
 | ~~~~~      | | ~~~~~~~~~  |
 | ~~~~~~~~   | | ~~~~~~~    |
 '------------'-'------------'`,
  map: String.raw`
 .--------.--------.--------.
 |  .     |        |    x   |
 |   '.   |  .--.  |   /    |
 |     '--+-'    '-+--'     |
 |        |        |        |
 '--------'--------'--------'`,
  shared: String.raw`
 .------------------.
 |    /\            |
 |   /  \   .------------------.
 |  /    \  |             /\   |
 '----------|    /\      /  \  |
            |   /  \    /    \ |
            '------------------'`,
  community: String.raw`
      (o)---------(o)
      / \         / \
     /   \       /   \
   (o)---(o)---(o)---(o)
     \   /       \   /
      \ /         \ /
      (o)---------(o)      `,
  frame: String.raw`
.---.
|/\ |
'---'`
};

export function AsciiArt({ art: text, className = '' }: { art: string; className?: string }) {
  return <pre className={'ascii-art ' + className} aria-hidden="true">{text.replace(/^\n/, '')}</pre>;
}

export function AsciiSpinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setFrame(value => (value + 1) % 4), 110);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="ascii-spinner" aria-hidden="true">[{'|/-\\'[frame]}]</span>;
}

function drawMap(points: { x: number; y: number }[], columns: number, rows: number) {
  if (columns < 12 || rows < 5) return '';
  const cells: string[][] = Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) =>
    row % 4 === 2 && column % 10 === 5 ? '+' : row % 4 === 2 && column % 2 === 1 ? '.' : column % 10 === 5 && row % 2 === 0 ? '.' : ' '));
  const spots = points.map(point => ({
    column: Math.round(Math.min(100, Math.max(0, point.x)) / 100 * (columns - 1)),
    row: Math.round(Math.min(100, Math.max(0, point.y)) / 100 * (rows - 1))
  }));
  for (let i = 1; i < spots.length; i++) {
    let { column, row } = spots[i - 1];
    const end = spots[i];
    const dx = Math.abs(end.column - column);
    const dy = Math.abs(end.row - row);
    const stepX = column < end.column ? 1 : -1;
    const stepY = row < end.row ? 1 : -1;
    let error = dx - dy;
    while (column !== end.column || row !== end.row) {
      const doubled = error * 2;
      const moveX = doubled > -dy;
      const moveY = doubled < dx;
      if (moveX) { error -= dy; column += stepX; }
      if (moveY) { error += dx; row += stepY; }
      cells[row][column] = moveX && moveY ? (stepX === stepY ? '\\' : '/') : moveX ? '-' : '|';
    }
  }
  return cells.map(line => line.join('')).join('\n');
}

/** A character-cell chart of the route between points given in percent of the box. */
export function AsciiMap({ points }: { points: { x: number; y: number }[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const [grid, setGrid] = useState({ columns: 0, rows: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const probe = document.createElement('canvas').getContext('2d');
    const measure = () => {
      const style = getComputedStyle(element);
      if (probe) probe.font = style.fontSize + ' ' + style.fontFamily;
      const cell = probe?.measureText('M').width || parseFloat(style.fontSize) * 0.6;
      const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3;
      const next = { columns: Math.floor(element.clientWidth / cell), rows: Math.floor(element.clientHeight / line) };
      setGrid(old => old.columns === next.columns && old.rows === next.rows ? old : next);
    };
    measure();
    let mounted = true;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // The cell width changes when the monospace webfont arrives.
    void document.fonts?.ready.then(() => { if (mounted) measure(); });
    return () => {
      mounted = false;
      observer.disconnect();
    };
  }, []);
  const key = points.map(point => point.x + ',' + point.y).join(' ');
  const text = useMemo(() => drawMap(points, grid.columns, grid.rows), [key, grid.columns, grid.rows]);
  return <pre ref={ref} className="ascii-map" aria-hidden="true">{text}</pre>;
}
