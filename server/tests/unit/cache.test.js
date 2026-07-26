const cache = require('../../lib/cache');

describe('cache (in-memory fallback)', () => {
  test('round-trips a value', async () => {
    await cache.set('k1', { v: 1 }, 60);
    expect(await cache.get('k1')).toEqual({ v: 1 });
  });
  test('returns null for missing key', async () => {
    expect(await cache.get('missing')).toBeNull();
  });
  test('getOrSet computes once', async () => {
    const loader = jest.fn(async () => ({ n: 42 }));
    const a = await cache.getOrSet('lazy', 60, loader);
    const b = await cache.getOrSet('lazy', 60, loader);
    expect(a).toEqual({ n: 42 });
    expect(b).toEqual({ n: 42 });
    expect(loader).toHaveBeenCalledTimes(1);
  });
  test('delPrefix removes matching keys', async () => {
    await cache.set('user:1:profile', { x: 1 }, 60);
    await cache.set('user:1:settings', { y: 2 }, 60);
    await cache.set('other:key', { z: 3 }, 60);
    await cache.delPrefix('user:1:');
    expect(await cache.get('user:1:profile')).toBeNull();
    expect(await cache.get('other:key')).toEqual({ z: 3 });
  });
});

