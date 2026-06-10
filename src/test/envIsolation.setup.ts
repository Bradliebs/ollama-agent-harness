// Test-environment isolation.
//
// Neutralize ambient harness env toggles so no unit test inherits a developer's
// shell configuration. HARNESS_VERIFY=1 is the dangerous one: with it set, any
// queryLoop test that performs a successful file edit would shell out through
// doneStateVerifier and run the real `npm test`, recursively re-entering this
// very suite (capped only by a 60s timeout) and producing nondeterministic
// `completed_with_test_failures` outcomes. HARNESS_VERIFY_PATH_CLAIMS is reset
// too because it mutates assistant output and would otherwise leak into tests.
//
// Tests that intentionally exercise these toggles (queryLoop.verify.test.ts)
// set them explicitly inside their own test bodies, which run after this hook.

delete process.env.HARNESS_VERIFY;
delete process.env.HARNESS_VERIFY_PATH_CLAIMS;

beforeEach(() => {
  delete process.env.HARNESS_VERIFY;
  delete process.env.HARNESS_VERIFY_PATH_CLAIMS;
});
