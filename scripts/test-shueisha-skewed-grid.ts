/** Privacy-safe synthetic regression for skewed/faint ruled settlement grids. */
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import {
  binarizePng,
  detectTableGrid,
  estimatePageSkewDegrees,
  rotatePng,
} from "../src/features/settlement/lib/parsers/ocr-pdf";

function ruledPage(opts: { angle?: number; faint?: boolean; noiseOnly?: boolean } = {}): Buffer {
  const width = 1200, height = 1600;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);
  ctx.translate(width / 2, height / 2);
  ctx.rotate(((opts.angle ?? 0) * Math.PI) / 180);
  ctx.translate(-width / 2, -height / 2);
  ctx.strokeStyle = opts.faint ? "rgb(170,170,170)" : "black";
  ctx.lineWidth = 3;
  if (opts.faint && !opts.noiseOnly) {
    // Real carbon-copy pages keep dark text even when the ruled lines are
    // faint. Synthetic text-like bars give skew estimation the same signal
    // without embedding any private content.
    ctx.fillStyle = "black";
    for (let row = 0; row < 8; row++) {
      for (let word = 0; word < 12; word++) {
        ctx.fillRect(100 + word * 70, 80 + row * 18, 30 + (word % 3) * 7, 4);
      }
    }
  }
  if (opts.noiseOnly) {
    for (let i = 0; i < 80; i++) {
      const x = (i * 137) % width, y = (i * 251) % height;
      ctx.fillStyle = "black";
      ctx.fillRect(x, y, 2, 2);
    }
  } else {
    const xs = [80, 640, 780, 930, 1040, 1120];
    const ys = Array.from({ length: 18 }, (_, i) => 260 + i * 55);
    for (const x of xs) { ctx.beginPath(); ctx.moveTo(x, ys[0]); ctx.lineTo(x, ys.at(-1)!); ctx.stroke(); }
    for (const y of ys) { ctx.beginPath(); ctx.moveTo(xs[0], y); ctx.lineTo(xs.at(-1)!, y); ctx.stroke(); }
  }
  return canvas.toBuffer("image/png");
}

async function main() {
  const aligned = ruledPage();
  const alignedBin = await binarizePng(aligned, 150);
  const alignedGrid = detectTableGrid(alignedBin);
  assert.ok(alignedGrid, "axis-aligned ruled grid is detected");
  assert.equal(alignedGrid.xs.length, 6);
  assert.equal(alignedGrid.ys.length, 18);
  assert.ok(Math.abs(estimatePageSkewDegrees(alignedBin)) < 0.15, "aligned page is not unnecessarily rotated");

  const skewed = ruledPage({ angle: 1 });
  const skewedBin = await binarizePng(skewed, 150);
  assert.equal(detectTableGrid(skewedBin), null, "axis-only detector rejects the uncorrected skewed grid");
  const estimate = estimatePageSkewDegrees(skewedBin);
  assert.ok(Math.abs(estimate - 1) <= 0.15, `bounded skew estimate stays near 1 degree (${estimate})`);
  const corrected = detectTableGrid(await binarizePng(await rotatePng(skewed, -estimate), 150));
  assert.ok(corrected, "deskewed page restores the ruled grid");
  assert.equal(corrected.xs.length, 6);
  assert.equal(corrected.ys.length, 18);

  const faint = ruledPage({ faint: true });
  const faint150 = detectTableGrid(await binarizePng(faint, 150));
  const faint180 = detectTableGrid(await binarizePng(faint, 180));
  assert.equal(faint150, null, "historical threshold does not invent a faint grid");
  assert.ok(faint180, "bounded 180 fallback recovers a faint grid");
  assert.equal(faint180.xs.length, 6);
  assert.equal(faint180.ys.length, 18);

  const faintSkewed = ruledPage({ angle: 1, faint: true });
  const faintSkewed150 = await binarizePng(faintSkewed, 150);
  const faintSkew = estimatePageSkewDegrees(faintSkewed150);
  const faintSkewedCorrected = await rotatePng(faintSkewed, -faintSkew);
  const faintSkewedGrid = detectTableGrid(await binarizePng(faintSkewedCorrected, 180));
  assert.ok(faintSkewedGrid, "combined skew plus faint rules recover after deskew and bounded threshold fallback");
  assert.equal(faintSkewedGrid.xs.length, 6);
  assert.equal(faintSkewedGrid.ys.length, 18);

  const large = ruledPage();
  const largeBin = await binarizePng(large, 150);
  const boundedEstimate = estimatePageSkewDegrees(largeBin, { maxSamplePoints: 1_024 });
  assert.ok(Number.isFinite(boundedEstimate), "small sampling budget remains deterministic");
  assert.throws(
    () => estimatePageSkewDegrees(largeBin, { maxPixels: 1_000 }),
    /pixel limit/,
    "oversized raster fails closed before skew work",
  );

  assert.throws(
    () => estimatePageSkewDegrees(largeBin, { coarseStepDegrees: 0.0001, fineStepDegrees: 0.00001 }),
    /invalid skew-analysis limits/,
    "pathological angle steps fail closed before candidate allocation",
  );

  const noise = ruledPage({ noiseOnly: true });
  assert.equal(detectTableGrid(await binarizePng(noise, 180)), null, "sparse noise is not classified as a table");
  console.log("test-shueisha-skewed-grid: all assertions passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
