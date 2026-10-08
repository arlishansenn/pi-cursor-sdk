// Tests must never append to the user's real action/usage logs. Individual
// suites override these with vi.stubEnv when they assert on log output.
process.env.CURSOR_SDK_ACTIONS_LOG ??= "0";
process.env.CURSOR_SDK_USAGE_LOG ??= "0";
// Theme side door: an operator-level pi install (e.g. a $HOME copy with newer
// okhsl theme data) must never leak into theme resolution — PI_PACKAGE_DIR
// bypasses module resolution entirely, so vitest externalization alone cannot
// isolate it (#46). Suites that assert on this variable stub it after setup.
delete process.env.PI_PACKAGE_DIR;
