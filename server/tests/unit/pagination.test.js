const { paginate, encodeCursor, decodeCursor } = require('../../lib/pagination');

function fakeModel(rows) {
  return {
    findMany: jest.fn(async ({ take, cursor, skip }) => {
      let start = 0;
      if (cursor && cursor.id) {
        const idx = rows.findIndex(r => r.id === cursor.id);
        start = idx + (skip || 0);
      }
      return rows.slice(start, start + take);
    }),
  };
}

describe('cursor pagination', () => {
  test('encodes/decodes cursor symmetrically', () => {
    expect(decodeCursor(encodeCursor('abc123'))).toBe('abc123');
    expect(decodeCursor(null)).toBeNull();
  });

  test('returns first page with nextCursor when more exists', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}` }));
    const model = fakeModel(rows);
    const page = await paginate(model, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBeTruthy();
  });

  test('returns final page with null nextCursor', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `r${i}` }));
    const model = fakeModel(rows);
    const page = await paginate(model, { limit: 10 });
    expect(page.items).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});

