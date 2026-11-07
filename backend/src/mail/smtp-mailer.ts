import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

import {
  Mailer,
  PasswordChangedMail,
  ResetMail,
  maskEmail,
} from './mailer.interface';

/**
 * A real SMTP transport, used when `MAIL_TRANSPORT=smtp`.
 *
 * `SMTP_URL` carries the credentials (`smtps://user:pass@smtp.host:465`) and
 * is validated at boot: if the transport is `smtp` and the URL is missing,
 * the API refuses to start rather than accept password-reset requests it
 * cannot fulfil. Nothing here writes to the in-memory dev outbox, so reset
 * tokens never accumulate in a long-running process.
 */
@Injectable()
export class SmtpMailer implements Mailer {
  private readonly logger = new Logger('Mail(smtp)');
  private readonly from =
    process.env.MAIL_FROM ?? 'AssetFlow <no-reply@assetflow.local>';
  private readonly transporter: Transporter;

  constructor(smtpUrl: string) {
    this.transporter = nodemailer.createTransport(smtpUrl);
  }

  async sendPasswordReset(mail: ResetMail): Promise<void> {
    await this.send(
      mail.to,
      'Reset your AssetFlow password',
      [
        `Hello ${mail.name},`,
        '',
        `The link below resets the AssetFlow password for ${mail.to}. It works once and expires in ${mail.expiresMinutes} minutes:`,
        '',
        mail.resetUrl,
        '',
        'If you did not ask for this, ignore this message — your password is unchanged.',
      ].join('\n'),
    );
    this.logger.log(`password reset mail sent to ${maskEmail(mail.to)}`);
  }

  async sendPasswordChanged(mail: PasswordChangedMail): Promise<void> {
    await this.send(
      mail.to,
      'Your AssetFlow password changed',
      [
        `Hello ${mail.name},`,
        '',
        'The password for your AssetFlow account was just changed, and every',
        'other signed-in session was signed out.',
        '',
        'If this was not you, reset your password immediately and tell your administrator.',
      ].join('\n'),
    );
    this.logger.log(`password-changed mail sent to ${maskEmail(mail.to)}`);
  }

  private async send(to: string, subject: string, text: string) {
    await this.transporter.sendMail({ from: this.from, to, subject, text });
  }
}
