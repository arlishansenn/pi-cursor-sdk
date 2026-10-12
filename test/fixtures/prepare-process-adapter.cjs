const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

cp.execFile = (file, args, options, callback) => {
  assert.equal(file, process.execPath);
  assert.equal(options.cwd, process.cwd());
  const build = args[0] === path.join(process.cwd(), 'scripts', 'build.mjs');
  if (!build) assert.equal(args[0], process.env.npm_execpath);
  const command = build ? 'build' : args.slice(1).join(' ');
  assert.ok(['build', 'install --include=dev --ignore-scripts', 'prune --omit=dev --ignore-scripts'].includes(command));
  fs.appendFileSync('events.txt', `${command}\n`);
  const failure = process.env.PREPARE_FAILURE;
  let diagnostic;
  if (failure === 'acquire' && command.startsWith('install')) diagnostic = 'acquisition diagnostic';
  if (failure === 'build-and-prune' && build) diagnostic = 'build diagnostic';
  if (failure === 'build-and-prune' && command.startsWith('prune')) diagnostic = 'prune diagnostic';
  if (diagnostic) {
    const error = new Error(diagnostic);
    error.code = 1;
    callback(error, '', `${diagnostic}\n`);
    return;
  }
  if (command.startsWith('install')) {
    fs.mkdirSync('node_modules/typescript', { recursive: true });
    fs.writeFileSync('node_modules/typescript/package.json', '{}');
  } else if (build) {
    fs.mkdirSync('dist', { recursive: true });
    fs.writeFileSync('dist/index.js', 'built by process adapter\n');
  } else {
    fs.rmSync('node_modules', { recursive: true, force: true });
  }
  callback(null, '', '');
};
syncBuiltinESMExports();
