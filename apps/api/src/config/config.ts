import { z } from 'zod';

/**
 * Process configuration, validated once at start. Anything the platform needs from the
 * environment is named here, so a misconfigured deployment fails at boot rather than on
 * the first payment.
 */
const base64Key = z
  .string()
  .transform((s) => Buffer.from(s, 'base64'))
  .refine((b) => b.length === 32, { message: 'must be 32 bytes, base64 encoded' });

/** An email address that may be absent or left blank in a .env file. */
const optionalEmail = z
  .string()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : undefined))
  .pipe(z.string().email().optional());

const schema = z.object({
  PROXIAPAY_ENV: z.enum(['production', 'sandbox']).default('sandbox'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  MASTER_KEY_BASE64: base64Key,
  INDEX_KEY_BASE64: base64Key,
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  CONSOLE_ORIGIN: z.string().url().default('http://localhost:5173'),
  ALERT_EMAIL: z.string().email().default('ops@example.com'),
  /** Initial delivery address per alert group of spec 8.6, seeded once; the console owns them afterwards. */
  ALERT_EMAIL_FINANCE: optionalEmail,
  ALERT_EMAIL_DEVELOPERS: optionalEmail,
  ALERT_EMAIL_ADMINISTRATORS: optionalEmail,
  SMTP_URL: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  PUBLIC_BASE_URL: z.string().url().optional(),
  /** Worker instance name, used when claiming jobs. */
  INSTANCE_NAME: z.string().default(() => `${process.pid}@${require('node:os').hostname()}`),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test support only: forget the cached configuration. */
export function resetConfigForTests(): void {
  cached = undefined;
}

export const CONFIG = Symbol('CONFIG');
