import { env } from '../config/env.js';

export const notFound = (req, res) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, _next) => {
  const statusCode = err.statusCode || 500;
  const payload = {
    success: false,
    message: err.message || 'Internal server error',
  };
  if (err.details) payload.details = err.details;
  if (env.nodeEnv === 'development' && statusCode === 500) {
    payload.stack = err.stack;
    // eslint-disable-next-line no-console
    console.error(err);
  }
  res.status(statusCode).json(payload);
};
