import 'reflect-metadata';
import { RequestMethod, type Type } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ConsoleApiModule } from '../console-api/console-api.module';
import { CLIENT_ACCESSIBLE } from '../console-api/client-access';
import { SessionGuard } from '../console-api/session.guard';

export interface ConsoleRoute { key: string; controller: Type; handler: (...args: unknown[]) => unknown; guarded: boolean; clientAccessible: boolean }

/** Every console handler Nest registers, as "METHOD path", read from the same metadata Nest routes by. */
export function consoleRoutes(): ConsoleRoute[] {
  const controllers = Reflect.getMetadata('controllers', ConsoleApiModule) as Type[];
  const routes: ConsoleRoute[] = [];
  for (const controller of controllers) {
    const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
    const classGuards = (Reflect.getMetadata(GUARDS_METADATA, controller) ?? []) as unknown[];
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      // The descriptor, not the property: reading a getter (`secure`) off the prototype would run it.
      const handler = Object.getOwnPropertyDescriptor(controller.prototype, name)?.value as unknown;
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (path === undefined) continue;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
      const full = `${base}/${path}`.split('/').filter(Boolean).join('/');
      const guards = [...classGuards, ...((Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[])];
      routes.push({
        key: `${method} ${full}`, controller, handler: handler as ConsoleRoute['handler'], guarded: guards.includes(SessionGuard),
        clientAccessible: Reflect.getMetadata(CLIENT_ACCESSIBLE, handler) === true,
      });
    }
  }
  return routes;
}
