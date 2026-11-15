import { Module } from '@nestjs/common';
import { BrandService } from './brand.service';

/** Payment links: the project's brand today; the links and the public page build on it. */
@Module({ providers: [BrandService], exports: [BrandService] })
export class PaymentLinksModule {}
