import { Injectable, Logger } from '@nestjs/common';
import type { Transporter } from 'nodemailer';

import {
  Mailer,
  PasswordChangedMail,
  ResetMail,
  maskEmail,
} from './mailer.interface';

/**
 * Load `nodemailer` the first time the SMTP transport actually sends anything.
 *
 * This used to be a top-level `import`, which put the package in the module
 * graph of *every* deployment — including the ones that never send mail. A
 * serverless bundle without it then fails while the file is being loaded,
 * before any handler exists to explain why: the platform answers its own `500`
 * with no `Access-Control-Allow-Origin` header, and the browser reports the
 * whole thing as "blocked by CORS policy". Loading it on demand keeps a mail
 * problem inside mail.
 */
function loadNodemailer(): typeof import('nodemailer') {
  try {
    // Required, not imported: `require` fails here — at the moment of use —
    // instead of at module load, which is the entire point of this function.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('nodemailer') as typeof import('nodemailer');
  } catch (error) {
    throw new Error(
      'MAIL_TRANSPORT=smtp needs the "nodemailer" package, but it could not be loaded (' +
        `${(error as Error).message}). Set MAIL_TRANSPORT=dev, or make sure the ` +
        'package ships with the deployment (includeFiles in vercel.json).',
    );
  }
}

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
  private transporter: Transporter | undefined;

  constructor(private readonly smtpUrl: string) {}

  /** Created on the first send — see `loadNodemailer()`. */
  private transport(): Transporter {
    this.transporter ??= loadNodemailer().createTransport(this.smtpUrl);
    return this.transporter;
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
    await this.transport().sendMail({ from: this.from, to, subject, text });
  }
}
