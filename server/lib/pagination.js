/**
 * ScopeCash AI — Pagination helpers
 *
 * Cursor-based pagination using opaque base64-encoded record IDs.
 * Avoids the off-by-one and consistency problems of offset/limit.
 */

const { z } = require('./validate');

const CursorQuerySchema = z.object({
  cursor: z.string().optional(),
  limit:  z.coerce.number().int().min(1).max(200).optional().default(50),
});

function encodeCursor(id) {
  if (!id) return null;
  return Buffer.from(String(id), 'utf8').toString('base64url');
}
function decodeCursor(c) {
  if (!c) return null;
  try { return Buffer.from(String(c), 'base64url').toString('utf8'); }
  catch { return null; }
}

/**
 * Page a Prisma model by id using cursor + limit.
 * Returns { items, nextCursor, hasMore }.
 *
 *   const page = await paginate(prisma.project, {
 *     where, orderBy: { createdAt: 'desc' }, idField: 'id',
 *     cursor: req.query.cursor, limit: req.query.limit,
 *   });
 */
async function paginate(model, opts) {
  const { where = {}, orderBy = { id: 'desc' }, select, include, idField = 'id' } = opts;
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 200);
  const cursorId = decodeCursor(opts.cursor);

  const args = {
    where, orderBy, take: limit + 1,
    ...(cursorId ? { cursor: { [idField]: cursorId }, skip: 1 } : {}),
    ...(select ? { select } : {}),
    ...(include ? { include } : {}),
  };
  const rows = await model.findMany(args);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, -1) : rows;
  const nextCursor = hasMore ? encodeCursor(items[items.length - 1][idField]) : null;
  return { items, nextCursor, hasMore };
}

module.exports = { CursorQuerySchema, encodeCursor, decodeCursor, paginate };

