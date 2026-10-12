const fs = require('node:fs');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const original = cp.execFile;

// Fault adapter, not a network outage. Only nested prepare acquisition uses an empty offline cache once.
cp.execFile = function (file, args, ...rest) {
  if (file === process.execPath && args?.[0] === process.env.npm_execpath &&
      args.slice(1).join(' ') === 'install --include=dev --ignore-scripts') {
    fs.appendFileSync(process.env.SOURCE_INSTALL_EVENTS, 'acquire\n');
    if (!fs.existsSync(process.env.SOURCE_INSTALL_ONCE)) {
      fs.writeFileSync(process.env.SOURCE_INSTALL_ONCE, 'injected\n', { flag: 'wx' });
      args = [...args, '--offline', '--cache', process.env.SOURCE_INSTALL_EMPTY_CACHE];
    }
  }
  return original.call(this, file, args, ...rest);
};
syncBuiltinESMExports();
