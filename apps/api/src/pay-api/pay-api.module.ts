import { Module } from '@nestjs/common';
import { PaymentLinksModule } from '../payment-links/payment-links.module';
import { PayApiController } from './pay-api.controller';

/** The public payment page's API under /pay-api/v1: its own module, apart from the console and the project API and their guards. */
@Module({ imports: [PaymentLinksModule], controllers: [PayApiController] })
export class PayApiModule {}
