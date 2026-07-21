import prisma from '../config/prisma.js';

// Central audit-trail helper. Call from any controller after a write.
export const logActivity = async ({ userId, action, entity, entityId, metadata, ipAddress }) => {
  try {
    await prisma.activityLog.create({
      data: { userId, action, entity, entityId, metadata, ipAddress },
    });
  } catch (e) {
    // Never let audit logging break the request.
    // eslint-disable-next-line no-console
    console.error('[activity] failed to log', e.message);
  }
};

export default logActivity;
