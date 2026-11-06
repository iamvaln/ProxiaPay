import { Module } from '@nestjs/common';
import { ClientsService } from './clients.service';
import { InvitationService } from './invitation.service';

@Module({ providers: [InvitationService, ClientsService], exports: [InvitationService, ClientsService] })
export class ClientsModule {}
