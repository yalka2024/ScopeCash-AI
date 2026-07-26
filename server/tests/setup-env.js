// Test environment defaults — runs before any test file is required.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-jwt-secret-must-be-at-least-32-characters-long-x';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:./test.db';
process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER || 'local';
process.env.STORAGE_LOCAL_DIR = process.env.STORAGE_LOCAL_DIR || './uploads-test';
process.env.AI_DAILY_TOKEN_LIMIT = process.env.AI_DAILY_TOKEN_LIMIT || '1000000';
process.env.LOGIN_MAX_FAILED = process.env.LOGIN_MAX_FAILED || '999';

