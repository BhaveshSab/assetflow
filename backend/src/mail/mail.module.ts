import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DevMailer } from './dev-mailer';
import { MAILER, Mailer } from './mailer.interface';
import { SmtpMailer } from './smtp-mailer';

/**
 * Chooses the mail transport once, at boot.
 *
 * `MAIL_TRANSPORT` is optional and defaults to `dev`: a fresh clone runs the
 * whole password-reset flow with no account anywhere and no secrets in the
 * environment. Setting it to `smtp` switches to real delivery and requires
 * `SMTP_URL`; the environment validator has already refused to boot without
 * it, so the constructor here can trust the value.
 */
@Global()
@Module({
  providers: [
    {
      provide: MAILER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Mailer => {
        const transport = (config.get<string>('MAIL_TRANSPORT') ?? 'dev')
          .trim()
          .toLowerCase();

        if (transport === 'smtp') {
          const url = config.get<string>('SMTP_URL') ?? '';
          new Logger('Mail').log('using the SMTP transport');
          return new SmtpMailer(url);
        }

        new Logger('Mail').log(
          'using the dev transport (messages go to var/mail — set MAIL_TRANSPORT=smtp to send real mail)',
        );
        return new DevMailer();
      },
    },
  ],
  exports: [MAILER],
})
export class MailModule {}
