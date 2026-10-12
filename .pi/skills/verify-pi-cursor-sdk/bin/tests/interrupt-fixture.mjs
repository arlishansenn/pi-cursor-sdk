import { ownedRun, cli } from '../owned-run.mjs';
cli(async () => {
  await ownedRun(process.argv[2], async ({ run }) => {
    await run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      drive: async () => {
        process.stdout.write('READY\n');
        await new Promise(() => {});
      },
    });
  });
});
