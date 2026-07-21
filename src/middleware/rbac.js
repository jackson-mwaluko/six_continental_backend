import ApiError from '../utils/ApiError.js';

// Role hierarchy — higher number = more privilege.
export const ROLE_RANK = {
  EMPLOYEE: 1,
  DEPARTMENT_MANAGER: 2,
  ICT_TECHNICIAN: 3,
  ICT_ADMIN: 4,
  SUPER_ADMIN: 5,
};

// authorize('ICT_ADMIN') => requires that role OR higher.
export const authorize = (...allowedRoles) => (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (allowedRoles.includes(req.user.role)) return next();
  return next(ApiError.forbidden('You do not have permission to perform this action'));
};

// minRole('ICT_TECHNICIAN') => requires at least that rank.
export const minRole = (role) => (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (ROLE_RANK[req.user.role] >= ROLE_RANK[role]) return next();
  return next(ApiError.forbidden('Insufficient privileges'));
};
