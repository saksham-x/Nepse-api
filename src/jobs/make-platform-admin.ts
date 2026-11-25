/**
 * Grants (or with --revoke, removes) the platform admin role for an existing account.
 *
 *   npm run make-platform-admin -- --email you@example.com
 *   npm run make-platform-admin -- --email you@example.com --revoke
 */
import { parseArgs } from 'node:util';
import { logger } from '../config/logger.js';
import { prisma } from '../config/prisma.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { email: { type: 'string' }, revoke: { type: 'boolean', default: false } } });
  const email = values.email?.trim().toLowerCase();
  if (!email) throw new Error('Pass --email <address> of an existing account');
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error(`No account with email ${email}. Sign up on the site first.`);
  const platformRole = values.revoke ? 'USER' : 'PLATFORM_ADMIN';
  await prisma.user.update({ where: { id: user.id }, data: { platformRole } });
  await prisma.auditLog.create({
    data: { action: 'platform.role_cli', entityType: 'user', entityId: String(user.id), summary: `${values.revoke ? 'Revoked' : 'Granted'} platform admin for ${email} from the command line` },
  });
  logger.info({ email, platformRole }, 'platform role updated');
}

try {
  await main();
} catch (err) {
  logger.error({ err }, 'make-platform-admin failed');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
