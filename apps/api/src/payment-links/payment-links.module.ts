import { Module } from '@nestjs/common';
import { BrandService } from './brand.service';
import { LinkPaymentsService } from './link-payments.service';
import { LinksService } from './links.service';
import { PublicLinkService } from './public-view';

/** Payment links: the project's brand, and the links a project publishes over it. */
@Module({ providers: [BrandService, LinksService, PublicLinkService, LinkPaymentsService], exports: [BrandService, LinksService, PublicLinkService, LinkPaymentsService] })
export class PaymentLinksModule {}
