/**
 * Outgoing mail.
 *
 * The API has exactly two messages to send today (a reset link and a "your
 * password changed" notice), so this is an interface with two implementations
 * rather than a framework:
 *
 *  * `DevMailer` — the default. Writes each message to `MAIL_DIR`
 *    (`var/mail` by default), keeps a copy in memory so the test-suite can
 *    read the token, and logs one line. Nothing leaves the machine.
 *  * `SmtpMailer` — used when `MAIL_TRANSPORT=smtp`. Requires `SMTP_URL`; the
 *    environment validator refuses to boot without it, because a password
 *    reset that silently sends nothing is worse than a server that will not
 *    start.
 *
 * Messages never contain the reset **hash** — only the link, which the
 * recipient is already the sole holder of.
 */

export type ResetMail = {
  to: string;
  name: string;
  resetUrl: string;
  expiresMinutes: number;
};

export type PasswordChangedMail = {
  to: string;
  name: string;
};

export interface Mailer {
  sendPasswordReset(mail: ResetMail): Promise<void>;
  sendPasswordChanged(mail: PasswordChangedMail): Promise<void>;
}

/** DI token — the concrete implementation is chosen from the environment. */
export const MAILER = Symbol('MAILER');

/** Mask an address for logs: `ada@example.com` → `a***@example.com`. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}
