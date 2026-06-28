import { validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';

// Legacy: run after express-validator chains to collect errors.
export const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(ApiError.badRequest('Validation failed', errors.array()));
  }
  next();
};

// Zod-based validation. Pass a schema for any of body/query/params.
// On success the parsed (and coerced) values replace req[key].
export const validateZod = (schemas) => (req, _res, next) => {
  try {
    for (const key of ['body', 'query', 'params']) {
      if (schemas[key]) {
        const result = schemas[key].safeParse(req[key]);
        if (!result.success) {
          const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
          return next(ApiError.badRequest('Validation failed', details));
        }
        try { req[key] = result.data; } catch { Object.assign(req[key], result.data); }
      }
    }
    next();
  } catch (e) {
    next(e);
  }
};

export default validate;
