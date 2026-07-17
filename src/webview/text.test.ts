import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { textBounds } from './render';

// Minimal stand-in for CanvasRenderingContext2D: textBounds only needs `font`
// and measureText(). This lets us test the baseline-aware bounds math without a
// real DOM/canvas.
function fakeCtx(charWidth: number): CanvasRenderingContext2D {
  return {
    font: '',
    measureText(text: string) {
      return { width: text.length * charWidth } as TextMetrics;
    },
  } as unknown as CanvasRenderingContext2D;
}

test('textBounds anchors width at x and box extends above the baseline', () => {
  const ctx = fakeCtx(6);
  const b = textBounds(ctx, 'abcd', 100, 200);
  assert.equal(b.x, 100);
  assert.equal(b.width, 24); // 4 chars * 6px
  // baseline at y=200; box must start above it (ascent) and include descent
  assert.ok(b.y < 200, `expected box top above baseline, got ${b.y}`);
  assert.ok(b.y + b.height > 200, `expected box bottom below baseline, got ${b.y + b.height}`);
});

test('a click on the baseline itself falls inside the text bounds', () => {
  const ctx = fakeCtx(6);
  const b = textBounds(ctx, 'hi', 50, 80);
  const clickX = 55;
  const clickY = 80; // exactly on the baseline
  assert.ok(clickX >= b.x && clickX <= b.x + b.width);
  assert.ok(clickY >= b.y && clickY <= b.y + b.height);
});

test('textBounds with literal \\n is taller and uses the widest line', () => {
  const ctx = fakeCtx(6);
  // Literal backslash-n (the two characters Java writes in .fzm files)
  const b = textBounds(ctx, 'ab\\ncdef', 10, 20);
  // 'ab' = 12px, 'cdef' = 24px → width is the widest line
  assert.equal(b.width, 24);
  // Two lines: height = single-line height + 1 * TEXT_LINE_H
  const singleLine = textBounds(ctx, 'cdef', 10, 20);
  assert.ok(b.height > singleLine.height, 'multiline text should be taller');
});
