/**
 * pm2 process definition: `pm2 start ecosystem.config.cjs && pm2 save`.
 *
 * Runs the server directly through tsx (no web rebuild on boot — run
 * `yarn --cwd web build` once yourself when the frontend changes). dotenv
 * picks up the repo-root .env from `cwd`, which also carries the Gate keys,
 * the Boros agent key and the opportunity-notification config; the server
 * re-asserts its 0600 mode on every boot.
 *
 * The SQLite store's EXCLUSIVE lock is the single-instance guard, so fork
 * mode with 1 instance is not just enough — a second instance would refuse
 * to boot rather than corrupt state.
 */
module.exports = {
  apps: [
    {
      name: 'arb-tools',
      cwd: __dirname,
      script: 'node_modules/tsx/dist/cli.mjs',
      args: 'src/server/index.ts',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5_000,
      // Timestamps in `pm2 logs arb-tools` — the notify scanner and the
      // reconcile loop both speak through console.log/error.
      time: true,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
