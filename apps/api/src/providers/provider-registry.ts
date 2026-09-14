import { Injectable } from '@nestjs/common';
import type { ProviderAdapter } from './adapter';
import { EjaraAdapter } from './adapters/ejara.adapter';
import { SimulatorAdapter } from './adapters/simulator.adapter';

/** Adapters by key. Adding a provider adds an adapter here and reference data in the catalogue; nothing above changes. */
@Injectable()
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();
  constructor() {
    for (const a of [new EjaraAdapter(), new SimulatorAdapter()]) this.adapters.set(a.key, a);
  }
  get(key: string): ProviderAdapter {
    const a = this.adapters.get(key);
    if (!a) throw new Error(`no adapter registered for ${key}`);
    return a;
  }
}
