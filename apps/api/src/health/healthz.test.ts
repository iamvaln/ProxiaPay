import { describe, expect, it } from 'vitest';
import { HealthzController } from './healthz.module';

describe('/healthz', () => {
  it('answers on the path the container probe and the proxy rely on', () => {
    expect(Reflect.getMetadata('path', HealthzController)).toBe('healthz');
  });

  it('reports liveness without a single injected dependency, so a database outage cannot make the process look dead', () => {
    // Constructor arity is the guarantee: the day someone injects the Db here, a failing
    // database would stop answering the probe and Compose would restart a healthy process.
    expect(HealthzController.length).toBe(0);
    expect(new HealthzController().live()).toEqual({ status: 'ok' });
  });
});

describe('the application', () => {
  it('mounts the health module, without which every container probe answers 404', async () => {
    const { AppModule } = await import('../app.module');
    const { HealthzModule } = await import('./healthz.module');
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    expect(imports).toContain(HealthzModule);
  });
});
