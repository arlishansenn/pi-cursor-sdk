// Tests must never append to the user's real action/usage logs. Individual
// suites override these with vi.stubEnv when they assert on log output.
process.env.CURSOR_SDK_ACTIONS_LOG ??= "0";
process.env.CURSOR_SDK_USAGE_LOG ??= "0";
