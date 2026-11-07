import { Injectable, Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

import {
  Mailer,
  PasswordChangedMail,
  ResetMail,
  maskEmail,
} from './mailer.interface';

/** One message the dev transport has "sent". */
export type SentMail = {
  to: string;
  subject: string;
  body: string;
  sentAt: Date;
  /** The reset token, when the message is a reset link. Tests read this. */
  token?: string;
};

/**
 * The messages the dev transport produced, newest last.
 *
 * Module-level on purpose: the e2e suite boots the real application in the
 * same process, so a test can import this array and read the token that was
 * mailed — no SMTP server, no network, no secret, and no "magic endpoint"
 * that would have to exist in production too.
 *
 * It is *only* populated when the dev transport is active; the SMTP transport
 * never writes here (production memory must not accumulate reset tokens).
 */
export const sentMail: SentMail[] = [];

/** Empty the in-memory outbox (called between tests). */
export function clearSentMail(): void {
  sentMail.length = 0;
}

/** The most recent reset link's token, or `undefined`. */
export function lastResetToken(): string | undefined {
  for (let i = sentMail.length - 1; i >= 0; i--) {
    if (sentMail[i].token) return sentMail[i].token;
  }
  return undefined;
}

/**
 * The default transport: nothing leaves the process.
 *
 * Every message is written to `MAIL_DIR` (so it can be opened in a browser
 * during a demo), remembered in memory (so tests can read it), and logged as
 * one line with the recipient masked.
 */
@Injectable()
export class DevMailer implements Mailer {
  private readonly logger = new Logger('Mail(dev)');
  private readonly dir = process.env.MAIL_DIR ?? 'var/mail';

  async sendPasswordReset(mail: ResetMail): Promise<void> {
    const token = extractToken(mail.resetUrl);
    const body = [
      `Hello ${mail.name},`,
      '',
      'Someone (hopefully you) asked to reset the AssetFlow password for',
      `${mail.to}. The link below works once and expires in ${mail.expiresMinutes} minutes:`,
      '',
      mail.resetUrl,
      '',
      'If you did not ask for this, ignore this message — your password is unchanged.',
    ].join('\n');

    await this.write(mail.to, 'Reset your AssetFlow password', body, token);
    this.logger.log(
      `password reset mail for ${maskEmail(mail.to)} → ${this.dir} (dev transport)`,
    );
  }

  async sendPasswordChanged(mail: PasswordChangedMail): Promise<void> {
    const body = [
      `Hello ${mail.name},`,
      '',
      'The password for your AssetFlow account was just changed, and every',
      'other signed-in session was signed out.',
      '',
      'If this was not you, reset your password immediately and tell your',
      'administrator.',
    ].join('\n');

    await this.write(mail.to, 'Your AssetFlow password changed', body);
    this.logger.log(
      `password-changed mail for ${maskEmail(mail.to)} (dev transport)`,
    );
  }

  private async write(
    to: string,
    subject: string,
    body: string,
    token?: string,
  ): Promise<void> {
    sentMail.push({ to, subject, body, sentAt: new Date(), token });

    try {
      await mkdir(this.dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = join(this.dir, `${stamp}-${sentMail.length}.txt`);
      await writeFile(
        file,
        `To: ${to}\nSubject: ${subject}\n\n${body}\n`,
        'utf8',
      );
    } catch (error) {
      // A read-only filesystem must not break the password reset: the message
      // is already in memory and in the log line.
      this.logger.warn(
        `could not write the mail file: ${(error as Error).message}`,
      );
    }
  }
}

/** The `token` query parameter of a reset link, if it has one. */
function extractToken(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get('token') ?? undefined;
  } catch {
    return undefined;
  }
}
