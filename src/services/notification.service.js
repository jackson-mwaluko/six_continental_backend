import prisma from '../config/prisma.js';
import { enqueueEmail } from './queue.js';
import { bus } from './eventBus.js';

// Creates an in-app notification, pushes it to live SSE clients, and
// (optionally) queues an email — without blocking the request.
export async function notify({ userId, type, title, message, link, email = false }) {
  const notification = await prisma.notification.create({
    data: { userId, type, title, message, link },
  });

  // Real-time push to any connected stream for this user.
  bus.emit(`notification:${userId}`, notification);

  if (email) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (user?.email) {
      enqueueEmail({
        notificationId: notification.id,
        to: user.email,
        subject: title,
        html: `<p>${message}</p>${link ? `<p><a href="${link}">View in IOMS</a></p>` : ''}`,
        text: message,
      });
    }
  }
  return notification;
}

export default { notify };
