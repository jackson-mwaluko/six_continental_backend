import prisma from '../config/prisma.js';

// Resolves the SLA policy for a priority and computes due timestamps.
export async function applySla(priority, createdAt = new Date()) {
  const policy = await prisma.slaPolicy.findFirst({
    where: { priority, isActive: true },
  });
  if (!policy) return { slaPolicyId: null, firstResponseDueAt: null, resolutionDueAt: null };

  const firstResponseDueAt = new Date(createdAt.getTime() + policy.firstResponseMins * 60000);
  const resolutionDueAt = new Date(createdAt.getTime() + policy.resolutionMins * 60000);
  return { slaPolicyId: policy.id, firstResponseDueAt, resolutionDueAt };
}
