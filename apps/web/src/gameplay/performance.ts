export class FrameMetrics {
  private samples: number[] = [];
  record(milliseconds: number) {
    if (Number.isFinite(milliseconds) && milliseconds > 0) {
      this.samples.push(milliseconds);
      if (this.samples.length > 1800) this.samples.shift();
    }
  }
  reset() { this.samples = []; }
  read() {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
    return { frames: sorted.length, elapsedSeconds: this.samples.reduce((sum, value) => sum + value, 0) / 1000,
      medianFps: sorted.length ? 1000 / percentile(0.5) : 0,
      p95FrameMs: sorted.length ? percentile(0.95) : 0 };
  }
}
