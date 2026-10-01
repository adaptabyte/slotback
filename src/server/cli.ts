import { randomBytes } from 'node:crypto';
import { ConfigError, loadConfig } from './config.ts';
import { App } from './runtime.ts';
import type { Role } from './db.ts';

const USAGE = `Slotback admin CLI

  npm run cli -- gen-key                          Print a new 32-byte encryption key (SLOTBACK_ENCRYPTION_KEY)
  npm run cli -- create-user <username> [--role admin|staff|provider] [--name "Display Name"]
                                                  Create a staff account and print its one-time setup link
  npm run cli -- setup-link <username>            Print a fresh setup link (password reset)
  npm run cli -- api-key <name>                   Create an API key for an integration
  npm run cli -- audit-verify                     Verify the audit log hash chain
  npm run cli -- poll                             Poll calendar/EHR sources once and process the outbox
`;

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'gen-key') {
    console.log(randomBytes(32).toString('base64'));
    return;
  }
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(USAGE);
    return;
  }
  const app = new App(loadConfig(), { log: () => {} });
  const actor = { type: 'system' as const, id: 'cli' };
  switch (cmd) {
    case 'create-user': {
      const username = args[0];
      const role = (arg(args, '--role') ?? 'staff') as Role;
      if (!username || !/^[A-Za-z0-9._-]{2,40}$/.test(username)) throw new Error('Usage: create-user <username> [--role admin]');
      if (!['admin', 'staff', 'provider'].includes(role)) throw new Error('Role must be admin, staff or provider');
      if (app.db.getUserByUsername(username)) throw new Error(`User ${username} already exists`);
      const user = app.db.createUser(username, arg(args, '--name') ?? username, role);
      app.audit.record(actor, 'user.created', { type: 'user', id: user.id }, { role });
      const token = app.db.createLinkToken('setup', user.id, new Date(Date.now() + 72 * 3600000).toISOString());
      console.log(`Created ${role} "${username}". Open this link within 72 hours to set a password and two-factor:\n${app.config.publicUrl}/staff/setup/${token}`);
      break;
    }
    case 'setup-link': {
      const user = app.db.getUserByUsername(args[0] ?? '');
      if (!user) throw new Error('Unknown user');
      app.db.revokeLinkTokens('setup', user.id);
      const token = app.db.createLinkToken('setup', user.id, new Date(Date.now() + 72 * 3600000).toISOString());
      app.audit.record(actor, 'user.setup_link', { type: 'user', id: user.id });
      console.log(`${app.config.publicUrl}/staff/setup/${token}`);
      break;
    }
    case 'api-key': {
      const name = args.join(' ').trim();
      if (!name) throw new Error('Usage: api-key <name>');
      const { id, key } = app.db.createApiKey(name);
      app.audit.record(actor, 'api_key.created', { type: 'api_key', id });
      console.log(`API key for "${name}" (shown once):\n${key}`);
      break;
    }
    case 'audit-verify': {
      const r = app.audit.verify();
      if (r.ok) console.log(`OK: ${r.count} audit entries, hash chain intact.`);
      else {
        console.error(`FAILED: audit chain broken at entry #${r.brokenAt}`);
        process.exitCode = 2;
      }
      break;
    }
    case 'poll': {
      await app.pollSources();
      await app.processOutbox();
      console.log('Done.');
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
  app.db.close();
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? `Configuration error: ${err.message}` : `Error: ${(err as Error).message}`);
  process.exit(1);
});
