import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { READ_POST, isReadRequest } from './read-posts';

describe('READ_POST', () => {
  it('is the same list the visual-review crawler lets through', () => {
    const require = createRequire(import.meta.url);
    const crawler = require(path.resolve(process.cwd(), 'tools/visual-review/read-posts.js')) as {
      READ_POST: RegExp;
    };
    expect(READ_POST.source).toBe(crawler.READ_POST.source);
    expect(READ_POST.flags).toBe(crawler.READ_POST.flags);
  });
});

describe('isReadRequest', () => {
  it('lets reads through', () => {
    expect(isReadRequest('GET', '/api/v1/lascodia-trading-engine/strategy/12')).toBe(true);
    expect(isReadRequest('head', '/x')).toBe(true);
    expect(isReadRequest('POST', '/api/v1/lascodia-trading-engine/position/list')).toBe(true);
    expect(isReadRequest('POST', '/api/v1/lascodia-trading-engine/trade-signal/preview')).toBe(
      true,
    );
    expect(isReadRequest('POST', '/api/hubs/realtime/negotiate')).toBe(true);
  });

  it('treats every other POST, and every PUT/PATCH/DELETE, as a write', () => {
    expect(isReadRequest('POST', '/api/v1/lascodia-trading-engine/strategy/12/pause')).toBe(false);
    expect(isReadRequest('POST', '/api/v1/lascodia-trading-engine/order')).toBe(false);
    expect(isReadRequest('PUT', '/api/v1/lascodia-trading-engine/position/list')).toBe(false);
    expect(isReadRequest('DELETE', '/api/v1/lascodia-trading-engine/alert/3')).toBe(false);
    expect(isReadRequest('PATCH', '/api/v1/lascodia-trading-engine/engine-config/x')).toBe(false);
  });
});
