import { Module } from '@nestjs/common';
import { BrandService } from './brand.service';
import { LinksService } from './links.service';

/** Payment links: the project's brand, and the links a project publishes over it. */
@Module({ providers: [BrandService, LinksService], exports: [BrandService, LinksService] })
export class PaymentLinksModule {}
