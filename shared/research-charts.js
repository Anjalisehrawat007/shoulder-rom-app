/**
 * research-charts.js — Phase 10: scatter, histogram, and heatmap charts for
 * the Clinical Validation workspace.
 * ----------------------------------------------------------------------------
 * Same construction convention as shared/joint-angle-chart.js (Phase 9) and
 * validation-portal/app.js's renderBlandAltmanChart (Phase 4): hand-rolled,
 * dependency-free inline SVG, template strings into container.innerHTML,
 * native <title> tooltips instead of a JS hover layer, thin marks. No
 * charting library introduced. Scatter/histogram geometry comes from
 * shared/reporting/chart-geometry.js's Phase 10 additions
 * (computeScatterPoints/computeHistogramBins) -- the same functions
 * backend/pdf-renderer.js's renderValidationReportPdf() uses to draw the
 * matching figures in the exported PDF, so on-screen and printed figures
 * can't disagree.
 *
 * Heatmap color: a single-hue sequential ramp (light-to-dark), the correct
 * encoding for a magnitude/count grid per this project's own dataviz
 * conventions -- built by varying the ALPHA of the project's existing
 * --signal teal (#2FA8A0, i.e. rgb(47,168,160)) rather than introducing a
 * new palette, since no continuous sequential ramp existed in
 * shared/style.css to reuse literally (only a 3-step qualitative
 * measured/estimated/unavailable set did).
 * ----------------------------------------------------------------------------
 */
import { computeScatterPoints, computeHistogramBins } from "./reporting/chart-geometry.js";

/**
 * AI-vs-clinician correlation scatter plot with a y=x reference line.
 * @param {HTMLElement} container
 * @param {Array<{x:number, y:number, label?:string}>} points - x=app value, y=clinician value
 * @param {{xLabel?:string, yLabel?:string}} [options]
 */
function renderScatterChart(container, points, { xLabel = "AI value", yLabel = "Clinician value" } = {}) {
  const width = 380;
  const height = 260;
  if (!points || points.length === 0) {
    container.innerHTML = `<p class="chart-empty">No paired data available for a scatter plot.</p>`;
    return;
  }
  const allVals = points.flatMap((p) => [p.x, p.y]).filter((v) => v != null);
  const domain = [Math.min(...allVals), Math.max(...allVals)];
  const { points: scaled, xScale, yScale, margin, innerWidth, innerHeight } = computeScatterPoints({ points, width, height, xDomain: domain, yDomain: domain });

  const refLine = `<line class="scatter-refline" x1="${xScale(domain[0])}" y1="${yScale(domain[0])}" x2="${xScale(domain[1])}" y2="${yScale(domain[1])}" />`;
  const dots = scaled
    .map((p) => `<circle class="scatter-point" cx="${p.x}" cy="${p.y}" r="4"><title>AI=${p.dataX.toFixed(1)}, Clinician=${p.dataY.toFixed(1)}</title></circle>`)
    .join("");

  container.innerHTML = `
    <svg class="research-chart scatter-chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      ${refLine}
      ${dots}
      <text class="chart-axis-label" x="${margin.left}" y="${height - 6}">${xLabel}</text>
      <text class="chart-axis-label" x="${margin.left - 28}" y="${margin.top + 10}" transform="rotate(-90, ${margin.left - 28}, ${margin.top + 10})">${yLabel}</text>
    </svg>
  `;
}

/**
 * Distribution histogram (confidence scores, rotation angles, ASRI
 * composites, Mallet grade counts, etc.).
 * @param {HTMLElement} container
 * @param {number[]} values
 * @param {{title?:string, binCount?:number}} [options]
 */
function renderHistogramChart(container, values, { title = "", binCount = 10 } = {}) {
  const width = 380;
  const height = 220;
  const geometry = computeHistogramBins({ values, binCount, width, height });
  if (!geometry) {
    container.innerHTML = `<p class="chart-empty">Not enough data for a distribution histogram (need at least 2 values).</p>`;
    return;
  }
  const bars = geometry.bins
    .map((b) => `<rect class="histogram-bar" x="${b.x}" y="${b.y}" width="${Math.max(0, b.width)}" height="${b.height}"><title>${b.binStart.toFixed(1)}-${b.binEnd.toFixed(1)}: ${b.count}</title></rect>`)
    .join("");
  const firstBin = geometry.bins[0];
  const lastBin = geometry.bins[geometry.bins.length - 1];
  container.innerHTML = `
    ${title ? `<div class="chart-title">${title}</div>` : ""}
    <svg class="research-chart histogram-chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      ${bars}
      <text class="chart-axis-label" x="${geometry.margin.left}" y="${height - 6}">${firstBin.binStart.toFixed(1)}</text>
      <text class="chart-axis-label" x="${geometry.margin.left + geometry.innerWidth}" y="${height - 6}" text-anchor="end">${lastBin.binEnd.toFixed(1)}</text>
    </svg>
  `;
}

/**
 * Confusion-matrix heatmap -- a color-graded grid, single-hue sequential
 * ramp (see file header). `confusionMatrix` is mallet-agreement.js's
 * buildConfusionMatrix() output shape ({grades, matrix, rowTotals, colTotals}).
 * @param {HTMLElement} container
 * @param {{grades:string[], matrix:number[][]}} confusionMatrix
 */
function renderHeatmapChart(container, confusionMatrix) {
  if (!confusionMatrix) {
    container.innerHTML = `<p class="chart-empty">No confusion matrix data available.</p>`;
    return;
  }
  const { grades, matrix } = confusionMatrix;
  const cellSize = 48;
  const labelGutter = 60;
  const width = labelGutter + grades.length * cellSize + 10;
  const height = labelGutter + grades.length * cellSize + 10;
  const maxCount = Math.max(...matrix.flat(), 1);

  let cells = "";
  for (let row = 0; row < grades.length; row++) {
    for (let col = 0; col < grades.length; col++) {
      const count = matrix[row][col];
      const alpha = count === 0 ? 0.04 : 0.15 + 0.75 * (count / maxCount);
      const x = labelGutter + col * cellSize;
      const y = labelGutter + row * cellSize;
      const textColor = alpha > 0.55 ? "#0F1E27" : "#F6F4EF";
      cells += `
        <rect class="heatmap-cell" x="${x}" y="${y}" width="${cellSize - 2}" height="${cellSize - 2}" fill="rgba(47,168,160,${alpha})">
          <title>Predicted ${grades[row]}, Clinician ${grades[col]}: ${count}</title>
        </rect>
        <text class="heatmap-cell-label" x="${x + cellSize / 2 - 2}" y="${y + cellSize / 2 + 4}" fill="${textColor}">${count}</text>
      `;
    }
  }
  const colLabels = grades.map((g, i) => `<text class="chart-axis-label" x="${labelGutter + i * cellSize + cellSize / 2 - 2}" y="${labelGutter - 8}" text-anchor="middle">${g}</text>`).join("");
  const rowLabels = grades.map((g, i) => `<text class="chart-axis-label" x="${labelGutter - 10}" y="${labelGutter + i * cellSize + cellSize / 2 + 4}" text-anchor="end">${g}</text>`).join("");

  container.innerHTML = `
    <svg class="research-chart heatmap-chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <text class="chart-axis-label" x="${labelGutter + (grades.length * cellSize) / 2}" y="12" text-anchor="middle">Clinician grade</text>
      <text class="chart-axis-label" x="12" y="${labelGutter + (grades.length * cellSize) / 2}" text-anchor="middle" transform="rotate(-90, 12, ${labelGutter + (grades.length * cellSize) / 2})">Predicted grade</text>
      ${colLabels}
      ${rowLabels}
      ${cells}
    </svg>
  `;
}

export { renderScatterChart, renderHistogramChart, renderHeatmapChart };
