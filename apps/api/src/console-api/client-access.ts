import { SetMetadata } from '@nestjs/common';

export const CLIENT_ACCESSIBLE = 'clientAccessible';

/**
 * Opens one console handler to client accounts. SessionGuard answers a client NOT_FOUND on every
 * handler without it, so a new endpoint stays closed to clients until someone opens it on purpose.
 * Read from the handler only: marking a controller would open its future handlers too.
 */
export const ClientAccessible = () => SetMetadata(CLIENT_ACCESSIBLE, true);
