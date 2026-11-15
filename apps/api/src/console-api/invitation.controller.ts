import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PlatformError } from '../common/errors';
import { parseBody } from '../http/validation';
import { InvitationService } from '../clients/invitation.service';
import { ClientAccessible } from './client-access';
import { SessionGuard, type ConsoleRequest } from './session.guard';

const acceptSchema = z.object({ password: z.string().max(256).optional() });

/**
 * Accepting an invitation. The link endpoints run before the invitee has any session, so no guard
 * stands in front of them; the token is all they go on. The membership endpoint is for a person
 * already signed in who was added to another client's team.
 */
@Controller('console')
export class InvitationController {
  constructor(private readonly invitations: InvitationService) {}

  @Get('invitations/:token')
  async preview(@Param('token') token: string) {
    return this.invitations.preview(token);
  }

  @Post('invitations/:token')
  @HttpCode(200)
  async accept(@Param('token') token: string, @Body() body: unknown) {
    const { password } = parseBody(acceptSchema, body);
    return this.invitations.accept(token, { password });
  }

  @Post('auth/memberships/:mid/accept')
  @ClientAccessible()
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async acceptMembership(@Param('mid') mid: string, @Req() req: ConsoleRequest) {
    if (!req.auth.isClient) throw new PlatformError('NOT_FOUND', 'Not found.');
    return this.invitations.acceptMembership(req.principal.administratorId, mid);
  }
}
