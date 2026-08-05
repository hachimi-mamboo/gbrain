/**
 * Pre-test setup: test processes never inherit a developer's live client
 * binding. These variables point at client-owned checkouts, so inheriting
 * them can make otherwise hermetic fixtures project into (or guard against)
 * a real brain repo before a test has declared any binding semantics.
 *
 * Clear them once, while Bun is evaluating preloads and before any test
 * module loads. Do not register a beforeEach hook here: tests that exercise
 * client binding intentionally own their values with the canonical withEnv
 * helper, and a global per-test reset would overwrite those explicit scopes.
 *
 * Imported first by bunfig.toml's test.preload list.
 */
delete process.env.GBRAIN_SOURCE;
delete process.env.GBRAIN_SOURCE_PATH;
delete process.env.GBRAIN_BRAIN_REPO_PATH;
