import { ConfigError, loadConfig } from './config.ts';
import { App } from './runtime.ts';
import { createHttpServer } from './server.ts';
import { seedDemo } from './seed.ts';

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const app = new App(config);
if (config.seedDemo) {
  const creds = seedDemo(app);
  if (creds) {
    console.log('\n  Demo practice seeded with synthetic patients.');
    console.log(`  Staff login:  ${config.publicUrl}/staff   user: ${creds.username}   password: ${creds.password}`);
    console.log(`  Patient form: ${config.publicUrl}/join\n`);
  }
}
if (!config.seedDemo && app.db.countUsers() === 0) {
  console.log('No staff accounts yet. Create one with:  npm run cli -- create-user <username> --role admin');
}

const server = createHttpServer(app);
server.listen(config.port, config.host, () => {
  app.log(`listening on ${config.host}:${config.port} (${config.env}) · public URL ${config.publicUrl}`);
  if (config.env !== 'production') app.log('DEVELOPMENT MODE: insecure demo key in use, do not enter real patient data.');
});
app.start();

function shutdown(signal: string) {
  app.log(`${signal} received, shutting down`);
  app.stop();
  server.close(() => {
    app.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
