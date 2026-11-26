import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { ROUTE_SCOPE, type RouteScope } from './route-scope.js';

export class RouteScopeMissingError extends Error {
  constructor(routes: readonly string[]) {
    super(`Routes without a scope declaration (CX-10): ${routes.join(', ')}`);
    this.name = 'RouteScopeMissingError';
  }
}

/** Refuses to start the application if any route lacks a scope declaration (CX-10, H-CTX-03). */
@Injectable()
export class RouteScopeCheck implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    const missing: string[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (instance === undefined || instance === null) continue;
      const prototype = Object.getPrototypeOf(instance) as object;
      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[method];
        if (
          typeof handler !== 'function' ||
          Reflect.getMetadata(PATH_METADATA, handler) === undefined
        )
          continue;
        const scope = this.reflector.getAllAndOverride<RouteScope | undefined>(ROUTE_SCOPE, [
          handler as (...args: unknown[]) => unknown,
          wrapper.metatype as new (...args: unknown[]) => unknown,
        ]);
        if (scope === undefined) missing.push(`${wrapper.name}.${method}`);
      }
    }
    if (missing.length > 0) throw new RouteScopeMissingError(missing);
  }
}
