// Tests drive the orchestrator in-process: it must not exec itself to scrub its environment (test/hardening.test.ts covers that).
process.env.SALU_ORCH_ENV ??= 'keep';
