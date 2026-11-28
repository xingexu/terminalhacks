import { useEffect, useState, type CSSProperties, type PointerEvent } from 'react';

const neutralPalette: CSSProperties = {
  '--scene-backdrop': '#171717',
  '--scene-surface': '#242424',
  '--scene-accent': '#bcbcbc'
} as CSSProperties;

const palettes = new Map<string, CSSProperties>();

function samplePalette(image: HTMLImageElement): CSSProperties {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return neutralPalette;

  ctx.drawImage(image, 0, 0, 32, 32);
  const pixels = ctx.getImageData(0, 0, 32, 32).data;
  const bins = Array.from({ length: 12 }, () => ({ red: 0, green: 0, blue: 0, weight: 0 }));
  for (let i = 0; i < pixels.length; i += 4) {
    const red = pixels[i];
    const green = pixels[i + 1];
    const blue = pixels[i + 2];
    const high = Math.max(red, green, blue);
    const low = Math.min(red, green, blue);
    const chroma = high - low;
    const light = (high + low) / 510;
    if (pixels[i + 3] < 200 || chroma < 20 || light < 0.12 || light > 0.9) continue;

    const hue = high === red ? (green - blue) / chroma : high === green ? 2 + (blue - red) / chroma : 4 + (red - green) / chroma;
    const bin = bins[Math.floor((hue * 2 + 12.5) % 12)];
    const weight = Math.sqrt(chroma) * (1 - Math.abs(light - 0.5));
    bin.red += red * weight;
    bin.green += green * weight;
    bin.blue += blue * weight;
    bin.weight += weight;
  }

  const dominant = bins.reduce((best, bin) => bin.weight > best.weight ? bin : best);
  if (!dominant.weight) return neutralPalette;
  const rgb = [dominant.red, dominant.green, dominant.blue].map(value => value / dominant.weight);
  const mix = (neutral: number, colorAmount: number) =>
    'rgb(' + rgb.map(value => Math.round(neutral * (1 - colorAmount) + value * colorAmount)).join(', ') + ')';
  return {
    '--scene-backdrop': mix(16, 0.16),
    '--scene-surface': mix(31, 0.27),
    '--scene-accent': mix(224, 0.55)
  } as CSSProperties;
}

export function useScenePalette(url?: string, enabled = true): CSSProperties {
  const [sample, setSample] = useState<{ url: string; colors: CSSProperties }>();
  useEffect(() => {
    if (!enabled || !url) return;
    const saved = palettes.get(url);
    if (saved) {
      setSample({ url, colors: saved });
      return;
    }

    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      let colors = neutralPalette;
      try { colors = samplePalette(image); } catch { /* Canvas access may be unavailable. */ }
      if (palettes.size >= 40) {
        const first = palettes.keys().next().value;
        if (first !== undefined) palettes.delete(first);
      }
      palettes.set(url, colors);
      setSample({ url, colors });
    };
    image.src = url;
    return () => { image.onload = null; };
  }, [url, enabled]);

  return enabled && sample && sample.url === url ? sample.colors : neutralPalette;
}

export function updateScenePointer(event: PointerEvent<HTMLElement>) {
  if (event.pointerType === 'touch' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const target = event.currentTarget;
  const { left, top } = target.getBoundingClientRect();
  target.style.setProperty('--reveal-x', event.clientX - left + 'px');
  target.style.setProperty('--reveal-y', event.clientY - top + 'px');
}
