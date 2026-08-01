# Reporting Engine

`report-generator.js` implements this directory's originally-planned
interface for the Modified Mallet combined report (Phase 6):
`generateMalletReport({session, taskResults, asriResult,
malletOverallResult, gradeOverrides, taskLabels, validationMetadata})`
returns a structured report object; `renderMarkdown(report)` renders it to
Markdown. `backend/pdf-renderer.js` (CommonJS, in `backend/` rather than
here since `pdfkit` is a Node-only dependency this directory's ESM modules
don't otherwise need) consumes the SAME structured object to produce a PDF
-- one data source, two renderers, no duplicated logic. See
`docs/mallet-score.md` for the full report contents and how JSON/PDF
export are wired to the backend.

**Still not implemented** (from the original plan, out of scope for
Phase 6): CSV/Excel export of raw+processed landmarks, and a
non-Mallet-specific general session report for the earlier 4-task
protocol. Every exported parameter carries its `measurementType`/
`confidence`/`limitation` metadata through to the report, per the
original design note below -- a research export that silently dropped
this distinction would misrepresent estimated parameters as measured ones.

Depends on: `shared/biomechanics/*` parameter schema (transitively, via
the objects it's handed), `shared/assessment/ModifiedMalletScoreEngine.js`
(for `GRADE_NUMERIC`), and whatever `asriResult`/`malletOverallResult`/
`taskResults` shapes its caller (`shared/assessment/ModifiedMalletWorkflow.js`
or `backend/server.js`) passes in -- it does not import ASRI/DMQE/ICQA
engines directly, only their already-computed output. Must not depend on
MediaPipe or any capture-time module directly (unchanged from the
original spec §11 constraint).
