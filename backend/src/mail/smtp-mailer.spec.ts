/**
 * The SMTP transport must not be able to take the whole API down.
 *
 * `nodemailer` used to be a top-level import, so a serverless bundle that was
 * missing it failed while the module graph was being loaded — before any
 * handler existed — and the platform answered a bare `500` without the CORS
 * header the browser needs to read the reason. These tests pin the contract:
 * constructing the mailer never touches the package, and the failure (when it
 * happens) names the package and the fix.
 */
import { SmtpMailer } from './smtp-mailer';

jest.mock('nodemailer', () => {
  throw new Error("Cannot find module 'nodemailer'");
});

const RESET = {
  to: 'ada@example.com',
  name: 'Ada',
  resetUrl: 'https://app.example.com/reset-password?token=abc',
  expiresMinutes: 30,
};

describe('SmtpMailer without the nodemailer package', () => {
  it('still constructs — nothing is loaded until something is sent', () => {
    expect(
      () => new SmtpMailer('smtps://user:pass@smtp.example.com:465'),
    ).not.toThrow();
  });

  it('explains itself when a message is actually sent', async () => {
    const mailer = new SmtpMailer('smtps://user:pass@smtp.example.com:465');

    await expect(mailer.sendPasswordReset(RESET)).rejects.toThrow(
      /MAIL_TRANSPORT=smtp needs the "nodemailer" package/,
    );
    await expect(mailer.sendPasswordReset(RESET)).rejects.toThrow(
      /Set MAIL_TRANSPORT=dev/,
    );
  });
});
