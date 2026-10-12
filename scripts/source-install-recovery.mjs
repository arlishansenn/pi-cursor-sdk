#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runRecoveryProcess } from "./lib/source-install-recovery-process.mjs";

const [optIn, piInput, repoInput, evidenceInput, cacheInput, ...extra] = process.argv.slice(2);
assert(optIn === "--run" && piInput && repoInput && evidenceInput && extra.length === 0,
  "Usage: node scripts/source-install-recovery.mjs --run /absolute/path/to/pi /source/repo /new/evidence-dir [npm-cache]");
const pi = resolve(piInput);
const repo = resolve(repoInput);
const evidence = resolve(evidenceInput);
assert(process.platform !== "win32", "source recovery verification supports POSIX only");
assert(existsSync(pi), "Pi executable must exist");
const tools = { node: realpathSync(process.execPath), npm: realpathSync(join(dirname(process.execPath), "npm")), git: realpathSync("/usr/bin/git") };
mkdirSync(evidence, { recursive: false });
const work = mkdtempSync(join(tmpdir(), "pi-source-recovery-"));
console.log(`Evidence retained at ${evidence}`);
const bin = join(work, "bin");
mkdirSync(bin);
for (const [name, path] of Object.entries(tools)) symlinkSync(path, join(bin, name));
const env = {
  PATH: `${bin}:/usr/bin:/bin`,
  HOME: join(work, "home"), USERPROFILE: join(work, "home"),
  PI_CODING_AGENT_DIR: join(work, "home", ".pi", "agent"),
  TMPDIR: work, TMP: work, TEMP: work,
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(work, "gitconfig"),
  GIT_TERMINAL_PROMPT: "0",
  npm_config_userconfig: join(work, "npmrc"),
  npm_config_globalconfig: join(work, "global-npmrc"),
  npm_config_cache: cacheInput ? resolve(cacheInput) : join(work, "cache"),
  npm_config_foreground_scripts: "true",
};
const project = join(work, "project");
const origin = join(work, "origin.git");
const source = "git:https://localhost/source/pi-cursor-sdk";
const pkg = join(env.PI_CODING_AGENT_DIR, "git", "localhost", "source", "pi-cursor-sdk");
const marker = join(dirname(pkg), `.${basename(pkg)}.pi-update-incomplete`);
let sequence = 0;
let cleanupSafe = true;
const provenance = { invocation: process.argv, cwd: process.cwd(), repo, pi, cache: env.npm_config_cache, work, tools, versions: {}, commands: [] };
const saveManifest = () => writeFileSync(join(evidence, "manifest.json"), JSON.stringify(provenance, null, 2) + "\n");
async function run(file, args, cwd = project, expectedFailure = false) {
  cleanupSafe = false;
  provenance.commands.push({ file, args, cwd });
  saveManifest();
  const result = await runRecoveryProcess(file, args, { cwd, env });
  cleanupSafe = result.cleanupSafe;
  writeFileSync(join(evidence, `${++sequence}-${basename(file)}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`);
  assert.ifError(result.error);
  assert.equal(result.signal, null, "child terminated by signal");
  if (!expectedFailure) assert.equal(result.status, 0, `${file} ${args.join(" ")} failed; inspect evidence`);
  return result;
}
try {
  mkdirSync(env.HOME);
  mkdirSync(project);
  mkdirSync(join(work, "empty-cache"));
  writeFileSync(env.npm_config_userconfig, "");
  writeFileSync(env.npm_config_globalconfig, "");
  for (const [name, path] of Object.entries({ ...tools, pi })) provenance.versions[name] = (await run(path, ["--version"])).stdout.trim();
  await run("git", ["clone", "--bare", repo, origin]);
  const head = (await run("git", ["rev-parse", "HEAD"], origin)).stdout.trim();
  const tree = (await run("git", ["rev-parse", "HEAD^{tree}"], origin)).stdout.trim();
  // A same-tree seed forces an update without depending on historical source revisions.
  const seed = (await run("git", ["-c", "user.name=Regression", "-c", "user.email=regression@example.invalid",
    "commit-tree", tree, "-m", "source install regression seed"], origin)).stdout.trim();
  Object.assign(provenance, { head, tree, seed });
  saveManifest();
  await run("git", ["update-ref", "refs/heads/recovery", seed], origin);
  await run("git", ["symbolic-ref", "HEAD", "refs/heads/recovery"], origin);
  await run("git", ["update-ref", "refs/heads/tested-head", head], origin);
  await run("git", ["bundle", "create", join(evidence, "source.bundle"), "refs/heads/recovery", "refs/heads/tested-head"], origin);
  await run("git", ["config", "--global", `url.${origin}.insteadOf`, "https://localhost/source/pi-cursor-sdk"]);
  await run(pi, ["install", source]);
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./dist/index.js"], "update manifest assertion if the extension entry changes");
  const entry = join(pkg, manifest.pi.extensions[0]);
  assert(existsSync(entry), "source install did not build the manifest entry");
  const prepare = readFileSync(join(pkg, "scripts/prepare.mjs"), "utf8");
  await run("git", ["update-ref", "refs/heads/recovery", head], origin);
  env.NODE_OPTIONS = `--require=${JSON.stringify(fileURLToPath(new URL("./source-install-recovery-adapter.cjs", import.meta.url)))}`;
  env.SOURCE_INSTALL_ONCE = join(evidence, "fault-consumed");
  env.SOURCE_INSTALL_EVENTS = join(evidence, "acquisitions.txt");
  env.SOURCE_INSTALL_EMPTY_CACHE = join(work, "empty-cache");
  const failed = await run(pi, ["update", source], project, true);
  writeFileSync(join(evidence, "failed-update-exit.txt"), `${failed.status}\n`);
  assert.notEqual(failed.status, 0, "injected update unexpectedly succeeded");
  assert(existsSync(env.SOURCE_INSTALL_ONCE), "nested acquisition adapter was not reached");
  assert.match(failed.stdout + failed.stderr, /ENOTCACHED/);
  assert(existsSync(marker), "failed update lost its incomplete marker");
  assert(!existsSync(entry), "expected destructive failed update to leave the manifest entry absent");
  writeFileSync(join(evidence, "failed-state.txt"), "incomplete marker present; manifest entry absent; ENOTCACHED observed\n");
  const failedHead = (await run("git", ["rev-parse", "HEAD"], pkg)).stdout.trim();
  assert.equal(failedHead, head);
  writeFileSync(join(evidence, "failed-head.txt"), `${failedHead}\n`);
  await run(pi, ["update", source]);
  const retryHead = (await run("git", ["rev-parse", "HEAD"], pkg)).stdout.trim();
  writeFileSync(join(evidence, "retry-head.txt"), `${retryHead}\n`);
  assert.equal(retryHead, failedHead);
  assert(existsSync(entry), "retry did not rebuild the manifest entry");
  assert(!existsSync(marker), "retry did not clear the marker");
  assert(!existsSync(join(pkg, "node_modules/typescript/package.json")), "retry did not prune the compiler");
  assert.equal(readFileSync(join(pkg, "scripts/prepare.mjs"), "utf8"), prepare);
  assert.equal(readFileSync(env.SOURCE_INSTALL_EVENTS, "utf8"), "acquire\nacquire\n");
  writeFileSync(join(evidence, "retry-state.txt"), "manifest entry present; incomplete marker absent; TypeScript pruned; prepare unchanged\n");
  delete env.NODE_OPTIONS;
  const help = await run(pi, ["--offline", "--approve", "--no-extensions", "--no-skills", "--no-prompt-templates",
    "--no-themes", "--no-context-files", "-e", pkg, "--help"]);
  for (const flag of ["--cursor-fast", "--cursor-no-fast", "--cursor-mode", "--cursor-local-resume"]) {
    assert(help.stdout.includes(flag), `extension help missing ${flag}`);
  }
  writeFileSync(join(evidence, "result.txt"), "PASS: destructive failed update recovered on same-head Pi retry; manifest rebuilt, compiler pruned, marker cleared, help registered. No model request.\n");
  console.log("PASS source install failure/retry regression");
} catch (error) {
  writeFileSync(join(evidence, "result.txt"), `${error.stack ?? error}\n${error.cause?.stack ?? ""}\nWorkspace ${cleanupSafe ? "safe to remove" : "retained"}: ${work}\n`);
  throw error;
} finally {
  if (cleanupSafe) rmSync(work, { recursive: true, force: true });
  else console.error(`Workspace retained because child termination is unconfirmed: ${work}`);
}
