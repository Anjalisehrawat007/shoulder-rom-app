/**
 * joint-angle-chart.js — Phase 9: multi-series joint-angle-over-time chart.
 * ----------------------------------------------------------------------------
 * Same hand-rolled, dependency-free inline-SVG construction convention as
 * doctor-portal's renderQualityTimelineChart and validation-portal's
 * renderBlandAltmanChart (thin marks, native <title> tooltips instead of a
 * JS hover layer, a legend, measured/estimated/unavailable-aware points) --
 * the only charting approach used anywhere in this codebase, continued here
 * rather than introducing a charting library.
 *
 * Coordinate math comes from shared/reporting/chart-geometry.js's
 * computeLineChartPoints() -- the SAME function backend/pdf-renderer.js's
 * renderResearchReportPdf() calls to draw the printed chart, so the
 * on-screen chart a clinician scrubs through and the chart embedded in the
 * PDF report can't silently disagree about where a point sits.
 *
 * An ES module (not a classic script like clinical-render.js/api-storage.js)
 * because it needs to import chart-geometry.js -- clinician-dashboard's
 * pages load their own page scripts as type="module" (matching
 * validation-portal/app.js's existing precedent), while still loading
 * config.js/api-storage.js/clinical-render.js as classic scripts the module
 * script can read off `window`. doctor-portal is NOT changed to use this
 * file (it has no joint-angle chart), so this introduces no risk there.
 * ----------------------------------------------------------------------------
 */
import { computeLineChartPoints } from "./reporting/chart-geometry.js";

const SERIES_DEFS = [
  { key: "shoulderAbductionDeg", label: "Abduction", color: "#2563eb" },
  { key: "shoulderFlexionDeg", label: "Flexion", color: "#9333ea" },
  { key: "externalRotationDeg", label: "External Rotation", color: "#16a34a" },
  { key: "internalRotationDeg", label: "Internal Rotation", color: "#dc2626" },
];

/**
 * @param {HTMLElement} container
 * @param {Array<{tSec:number, shoulderAbductionDeg:object, shoulderFlexionDeg:object, externalRotationDeg:object, internalRotationDeg:object}>} frames
 *   - the angle-timeseries endpoint's `frames` array (each field is a
 *     {value, measurementType, confidence} envelope-projection, per
 *     backend/server.js's pickEnvelope()).
 * @param {object} [options]
 * @param {number} [options.currentTSec] - if supplied, draws a vertical
 *   cursor line at this time (for the video-sync scrubber in review.js).
 * @param {Array<string>} [options.visibleKeys] - which of SERIES_DEFS to draw; defaults to all.
 */
function renderJointAngleChart(container, frames, { currentTSec = null, visibleKeys = null } = {}) {
  const width = 640;
  const height = 260;
  const activeSeries = SERIES_DEFS.filter((d) => !visibleKeys || visibleKeys.includes(d.key));

  if (!frames || frames.length === 0) {
    container.innerHTML = `<p class="chart-empty">No joint-angle time series available for this task.</p>`;
    return;
  }

  const allValues = [];
  const seriesGeometry = activeSeries.map((def) => {
    const series = frames.map((f) => ({ tSec: f.tSec, value: f[def.key]?.value ?? null }));
    for (const s of series) if (s.value != null) allValues.push(s.value);
    return { def, series };
  });
  // Shared y-domain across all series so a clinician can compare abduction
  // vs. rotation on the same visual scale, not four independently-scaled charts.
  const yDomain = allValues.length ? [Math.min(0, ...allValues), Math.max(...allValues)] : [0, 1];
  const xDomain = [frames[0].tSec, frames[frames.length - 1].tSec];

  let geometry = null;
  const paths = seriesGeometry
    .map(({ def, series }) => {
      const g = computeLineChartPoints({ series, width, height, xDomain, yDomain });
      geometry = g; // identical margin/scale across series -- last one is representative for the axes below
      if (g.points.length === 0) return "";
      const linePoints = g.points.map((p) => `${p.x},${p.y}`).join(" ");
      const dots = g.points
        .map((p) => {
          const frame = frames.find((f) => f.tSec === p.tSec);
          const env = frame?.[def.key];
          const cls = env?.measurementType === "measured" ? "measured" : env?.measurementType === "estimated" ? "estimated" : "unavailable";
          return `<circle class="angle-point ${cls}" cx="${p.x}" cy="${p.y}" r="2.5" fill="${def.color}"><title>${def.label} t=${p.tSec.toFixed(2)}s: ${p.value}° (${env?.measurementType ?? "unavailable"})</title></circle>`;
        })
        .join("");
      return `<polyline class="angle-line" points="${linePoints}" stroke="${def.color}" fill="none" stroke-width="2" />${dots}`;
    })
    .join("");

  const cursorLine =
    currentTSec != null && geometry
      ? `<line class="angle-cursor" x1="${geometry.xScale(currentTSec)}" y1="${geometry.margin.top}" x2="${geometry.xScale(currentTSec)}" y2="${geometry.margin.top + geometry.innerHeight}" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="4,3" />`
      : "";

  const legend = activeSeries
    .map((def, i) => `<span class="angle-legend-item"><span class="angle-swatch" style="background:${def.color}"></span>${def.label}</span>`)
    .join("");

  const xAxisLabel = geometry
    ? `<text class="angle-axis-label" x="${geometry.margin.left}" y="${height - 6}">${xDomain[0].toFixed(1)}s</text>
       <text class="angle-axis-label" x="${geometry.margin.left + geometry.innerWidth}" y="${height - 6}" text-anchor="end">${xDomain[1].toFixed(1)}s</text>`
    : "";

  container.innerHTML = `
    <div class="angle-legend">${legend}</div>
    <svg class="angle-chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      ${paths}
      ${cursorLine}
      ${xAxisLabel}
    </svg>
  `;
}

export { renderJointAngleChart, SERIES_DEFS };
