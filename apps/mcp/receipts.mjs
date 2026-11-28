import { setTimeout as sleep } from 'node:timers/promises';

export async function waitForMovementResult(initial, readContext, { timeoutMs = 6500, now = Date.now, delay = sleep } = {}) {
  const command = initial.data?.command;
  if (initial.data?.status !== 'queued' || !command?.id) return initial;
  const deadline = now() + timeoutMs;
  const pending = message => ({ ...initial, data: { ...initial.data, message } });
  while (now() < deadline) {
    let context;
    try { context = await readContext(AbortSignal.timeout(Math.max(1, deadline - now()))); }
    catch { return pending('Command sent; the browser result could not be confirmed.'); }
    const receipt = context.movementReceipt;
    if (receipt?.commandId === command.id && receipt.worldId === command.worldId &&
      receipt.viewerId === command.viewerId) {
      const message = receipt.status === 'completed'
        ? (command.direction.startsWith('turn_') ? 'Turn completed.' : 'Movement completed.') +
          (Number.isFinite(receipt.heading) ? ` Heading ${Math.round(receipt.heading)}°.` : '')
        : receipt.status === 'stopped' ? 'Movement stopped.'
          : `Movement ${receipt.status}.` + (receipt.reason ? ' ' + receipt.reason : '');
      return { ...initial, data: { ...initial.data, status: receipt.status, receipt, message } };
    }
    if (context.movement?.id && context.movement.id !== command.id) return pending('A newer command replaced this movement before its result was confirmed.');
    await delay(Math.min(150, Math.max(0, deadline - now())));
  }
  return pending('Command sent; no browser result yet. Keep the scene open and check again.');
}
