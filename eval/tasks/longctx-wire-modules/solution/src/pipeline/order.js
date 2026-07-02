// order.js — the canonical execution order of the pipeline (stage names, earliest first).
// Priorities: ingest 10 · validate 20 · emit 30 · transform 40.
module.exports = { STAGE_SEQUENCE: ['ingest', 'validate', 'emit', 'transform'] }
