import { verifyAccessToken } from '../utils/jwt.js';
import ApiError from '../utils/ApiError.js';
import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';

// Verifies the Bearer access token and attaches the user to req.user.
export const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw ApiError.unauthorized('Missing access token');

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw ApiError.unauthorized('Invalid or expired token');
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: {
      id: true, email: true, firstName: true, lastName: true,
      role: true, isActive: true, departmentId: true,
    },
  });
  if (!user || !user.isActive) throw ApiError.unauthorized('Account not found or inactive');

  req.user = user;
  next();
});

export default authenticate;
