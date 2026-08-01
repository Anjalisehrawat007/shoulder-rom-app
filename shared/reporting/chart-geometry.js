/**
 * chart-geometry.js — Phase 9: shared line-chart coordinate math.
 * ----------------------------------------------------------------------------
 * Pure, dependency-free. Consumed by BOTH shared/joint-angle-chart.js
 * (browser, draws SVG points/lines) and backend/pdf-renderer.js (Node,
 * draws pdfkit vector moveTo/lineTo calls) so the on-screen chart in the
 * clinician dashboard and the printed chart in the research-report PDF
 * compute identical (x,y) positions for identical data -- neither renderer
 * has its own competing scale math to silently drift out of sync with the
 * other.
 * ----------------------------------------------------------------------------
 */

/**
 * @param {object} args
 * @param {Array<{tSec:number, value:number|null}>} args.series
 * @param {number} args.width
 * @param {number} args.height
 * @param {{top:number,right:number,bottom:number,left:number}} [args.margin]
 * @param {[number,number]} [args.xDomain] - defaults to the series' own min/max tSec
 * @param {[number,number]} [args.yDomain] - defaults to the series' own min/max value (padded slightly)
 * @returns {{points: Array<{x:number,y:number,tSec:number,value:number}>, xScale: Function, yScale: Function, innerWidth:number, innerHeight:number, xMin:number, xMax:number, yMin:number, yMax:number}}
 */
function computeLineChartPoints({ series, width, height, margin = { top: 10, right: 10, bottom: 24, left: 36 }, xDomain, yDomain }) {
  const innerWidth = Math.max(1, width - margin.left - margin.right);
  const innerHeight = Math.max(1, height - margin.top - margin.bottom);

  const valid = series.filter((p) => p.value != null && Number.isFinite(p.value));
  const xs = series.map((p) => p.tSec);
  const ys = valid.map((p) => p.value);

  const xMin = xDomain ? xDomain[0] : Math.min(...xs, 0);
  const xMax = xDomain ? xDomain[1] : Math.max(...xs, 1);
  const rawYMin = yDomain ? yDomain[0] : Math.min(...ys, 0);
  const rawYMax = yDomain ? yDomain[1] : Math.max(...ys, 1);
  // A little headroom so a flat-line series (yMin === yMax) still renders
  // as a visible horizontal line, not a zero-height chart.
  const yPad = rawYMax === rawYMin ? 1 : (rawYMax - rawYMin) * 0.08;
  const yMin = rawYMin - yPad;
  const yMax = rawYMax + yPad;

  const xScale = (tSec) => margin.left + ((tSec - xMin) / (xMax - xMin || 1)) * innerWidth;
  const yScale = (value) => margin.top + innerHeight - ((value - yMin) / (yMax - yMin || 1)) * innerHeight;

  const points = valid.map((p) => ({ x: xScale(p.tSec), y: yScale(p.value), tSec: p.tSec, value: p.value }));

  return { points, xScale, yScale, innerWidth, innerHeight, xMin, xMax, yMin, yMax, margin };
}

/**
 * Phase 10 addition: a NEUTRAL {x,y} scatter-point scaler, distinct from
 * computeLineChartPoints() above -- that function's API is genuinely
 * time-series-shaped (field named `tSec`, x always assumed present, only
 * `value`/y may be null), which doesn't fit arbitrary independent (x,y)
 * pairs where either coordinate can be missing per-point. Rather than
 * repurpose the time-series function (confirmed during Phase 10 research
 * as technically possible but semantically misleading), this is a small,
 * separate, honestly-named function -- computeLineChartPoints() itself is
 * untouched, so Phase 9's joint-angle chart and PDF renderer are unaffected.
 * @param {object} args
 * @param {Array<{x:number|null, y:number|null}>} args.points
 * @param {number} args.width
 * @param {number} args.height
 * @param {{top:number,right:number,bottom:number,left:number}} [args.margin]
 * @param {[number,number]} [args.xDomain]
 * @param {[number,number]} [args.yDomain]
 * @returns {{points: Array<{x:number,y:number,dataX:number,dataY:number}>, xScale: Function, yScale: Function, innerWidth:number, innerHeight:number, xMin:number, xMax:number, yMin:number, yMax:number, margin:object}}
 */
function computeScatterPoints({ points, width, height, margin = { top: 10, right: 10, bottom: 24, left: 36 }, xDomain, yDomain }) {
  const innerWidth = Math.max(1, width - margin.left - margin.right);
  const innerHeight = Math.max(1, height - margin.top - margin.bottom);

  const valid = points.filter((p) => p.x != null && p.y != null && Number.isFinite(p.x) && Number.isFinite(p.y));
  const xs = valid.map((p) => p.x);
  const ys = valid.map((p) => p.y);

  const rawXMin = xDomain ? xDomain[0] : Math.min(...xs, 0);
  const rawXMax = xDomain ? xDomain[1] : Math.max(...xs, 1);
  const rawYMin = yDomain ? yDomain[0] : Math.min(...ys, 0);
  const rawYMax = yDomain ? yDomain[1] : Math.max(...ys, 1);
  // Same flat-data headroom principle as computeLineChartPoints(), applied
  // to both axes here since either can legitimately be constant for scatter data.
  const xPad = rawXMax === rawXMin ? 1 : (rawXMax - rawXMin) * 0.08;
  const yPad = rawYMax === rawYMin ? 1 : (rawYMax - rawYMin) * 0.08;
  const xMin = rawXMin - xPad;
  const xMax = rawXMax + xPad;
  const yMin = rawYMin - yPad;
  const yMax = rawYMax + yPad;

  const xScale = (x) => margin.left + ((x - xMin) / (xMax - xMin || 1)) * innerWidth;
  const yScale = (y) => margin.top + innerHeight - ((y - yMin) / (yMax - yMin || 1)) * innerHeight;

  const scaledPoints = valid.map((p) => ({ x: xScale(p.x), y: yScale(p.y), dataX: p.x, dataY: p.y }));

  return { points: scaledPoints, xScale, yScale, innerWidth, innerHeight, xMin, xMax, yMin, yMax, margin };
}

/**
 * Phase 10 addition: histogram bin geometry -- bins a flat array of values
 * into `binCount` equal-width buckets and returns each bin's pixel
 * rectangle, ready for either an SVG <rect> (browser) or a pdfkit
 * doc.rect() call (PDF) to consume directly, the same "compute once,
 * render twice" principle computeLineChartPoints() already established.
 * @param {object} args
 * @param {number[]} args.values
 * @param {number} [args.binCount=10]
 * @param {number} args.width
 * @param {number} args.height
 * @param {{top:number,right:number,bottom:number,left:number}} [args.margin]
 * @returns {{bins: Array<{binStart:number, binEnd:number, count:number, x:number, y:number, width:number, height:number}>, maxCount:number, innerWidth:number, innerHeight:number, margin:object}|null} null if fewer than 2 finite values
 */
function computeHistogramBins({ values, binCount = 10, width, height, margin = { top: 10, right: 10, bottom: 24, left: 36 } }) {
  const finite = values.filter((v) => v != null && Number.isFinite(v));
  if (finite.length < 2) return null;

  const innerWidth = Math.max(1, width - margin.left - margin.right);
  const innerHeight = Math.max(1, height - margin.top - margin.bottom);

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const range = max - min || 1;
  const binWidth = range / binCount;

  const counts = new Array(binCount).fill(0);
  for (const v of finite) {
    const idx = Math.min(binCount - 1, Math.floor((v - min) / binWidth));
    counts[idx]++;
  }
  const maxCount = Math.max(...counts, 1);

  const barGap = 1; // px gap between bars, matches this project's established 2px-gap convention loosely (kept 1px given typical histogram bar widths are already narrow)
  const bins = counts.map((count, i) => {
    const binStart = min + i * binWidth;
    const binEnd = binStart + binWidth;
    const barHeight = (count / maxCount) * innerHeight;
    return {
      binStart,
      binEnd,
      count,
      x: margin.left + (i / binCount) * innerWidth + barGap / 2,
      y: margin.top + innerHeight - barHeight,
      width: innerWidth / binCount - barGap,
      height: barHeight,
    };
  });

  return { bins, maxCount, innerWidth, innerHeight, margin };
}

export { computeLineChartPoints, computeScatterPoints, computeHistogramBins };
