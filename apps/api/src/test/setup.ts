import { resetConfigForTests } from '../config/config';
import { addressResolver } from '../notifications/public-address';

process.env.NODE_ENV = 'test';
process.env.PROXIAPAY_ENV = process.env.PROXIAPAY_ENV ?? 'sandbox';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/proxiapay_test';
process.env.MASTER_KEY_BASE64 = process.env.MASTER_KEY_BASE64 ?? Buffer.alloc(32, 1).toString('base64');
process.env.INDEX_KEY_BASE64 = process.env.INDEX_KEY_BASE64 ?? Buffer.alloc(32, 2).toString('base64');
process.env.LOG_LEVEL = 'fatal';
resetConfigForTests();

// No test resolves a real name: every name answers with one public address unless a test says otherwise.
addressResolver.lookup = async () => ['93.184.215.14'];
