import { spawn } from "node:child_process";
import { terminateChild } from "./cursor-child-process.mjs";

// Detached process groups cover ordinary npm descendants, not processes that create a new session.
export async function runRecoveryProcess(file, args, { cwd, env, timeoutMs = 15 * 60_000, graceMs = 2_000 }) {
  if (process.platform === "win32") throw new Error("source recovery verification requires POSIX process groups");
  const child = spawn(file, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const result = { stdout: "", stderr: "", status: null, signal: null, error: undefined, cleanupSafe: false };
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const fail = (error) => { result.error ??= error; finish(); };
  child.once("error", fail);
  child.once("close", (status, signal) => { result.status = status; result.signal = signal; finish(); });
  for (const name of ["stdout", "stderr"]) {
    child[name].setEncoding("utf8");
    child[name].on("data", (text) => {
      if (result.stdout.length + result.stderr.length + text.length > 32 * 1024 * 1024) {
        fail(new Error("child output exceeded 32 MiB"));
      } else result[name] += text;
    });
  }
  const onSignal = (signal) => fail(new Error(`interrupted by ${signal}`));
  const onInt = () => onSignal("SIGINT");
  const onTerm = () => onSignal("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const timer = setTimeout(() => fail(new Error(`child timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    await done;
    await terminateChild(child, { graceMs });
    result.cleanupSafe = true;
  } catch (error) {
    result.error = new Error("child termination unconfirmed; retain workspace", { cause: error });
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }
  return result;
}
