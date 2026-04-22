# Canvas and DOM isolation

Use this shard when rendering code depends on `document`, `window`, or `canvas` APIs but the logic itself should still be tested in a narrow harness.

## Install and config

```bash
npm install -D vitest jsdom
```

```ts
// src/render-meter.ts
export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d'): { fillRect(x: number, y: number, w: number, h: number): void } | null;
}

export function renderMeter(canvas: CanvasLike, ratio: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2d context unavailable');
  }

  ctx.fillRect(0, 0, canvas.width * ratio, canvas.height);
}
```

```ts
// test/render-meter.test.ts
import { describe, expect, it, vi } from 'vitest';
import { renderMeter } from '../src/render-meter';

describe('renderMeter', () => {
  it('draws using an injected canvas double', () => {
    const fillRect = vi.fn();
    const canvas = {
      width: 200,
      height: 20,
      getContext: () => ({ fillRect }),
    };

    renderMeter(canvas, 0.5);
    expect(fillRect).toHaveBeenCalledWith(0, 0, 100, 20);
  });
});
```

## Common pitfalls

- Do not make every render test boot a full browser when a small canvas double is enough.
- Inject environment dependencies instead of reading globals directly from business logic.
- Test DOM wiring separately from pure drawing or layout math.

## Determinism notes

- Mock `ResizeObserver`, `matchMedia`, and `requestAnimationFrame` only when the unit under test touches them.
- Keep canvas assertions about draw calls and dimensions, not pixel-perfect screenshots, unless visual regression tooling is already established.
- If a browser E2E is required, put it in the Playwright shard and leave this shard for local logic isolation.
