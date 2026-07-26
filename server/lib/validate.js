/**
 * Validation + central error helpers using Zod.
 */
const { z, ZodError } = require('zod');

class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message); this.status = status; this.code = code || 'error'; this.details = details;
  }
}

function validate(schema, where = 'body') {
  return (req, res, next) => {
    const target = req[where];
    const result = schema.safeParse(target);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        code: 'validation_error',
        details: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    req[where] = result.data;
    next();
  };
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function errorMiddleware(err, req, res, next) {
  const isProd = process.env.NODE_ENV === 'production';
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Validation failed', code: 'validation_error', details: err.issues });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
  }
  // Multer reports client faults (oversized file, too many parts) as errors carrying
  // neither `status` nor `statusCode`, so the fallback below would log them as 500s
  // and burn the error budget on what is really a 4xx. Checked by name so this file
  // does not have to depend on multer.
  if (err.name === 'MulterError') {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: err.message, code: err.code, requestId: req.requestId });
  }
  const status = err.status || err.statusCode || 500;
  const body = {
    error: status >= 500 && isProd ? 'Internal server error' : (err.message || 'Internal server error'),
    code:  err.code || (status >= 500 ? 'internal_error' : 'request_error'),
    requestId: req.requestId,
  };
  if (!isProd && status >= 500) body.stack = err.stack;
  console.error(JSON.stringify({ type: 'error', requestId: req.requestId, status,
    message: err.message, stack: isProd ? undefined : err.stack }));
  res.status(status).json(body);
}

module.exports = { z, validate, asyncHandler, HttpError, errorMiddleware };

