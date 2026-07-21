import prisma from '../config/prisma.js';
import { ROLE_RANK } from '../middleware/rbac.js';

/*
 * Company access model
 * --------------------
 * A user's access is defined by:
 *   - allCompanies = true  → sees everything across the whole group (group-wide).
 *   - otherwise           → the union of their explicit `companies` (M2M access
 *                            set) plus their primary `companyId`.
 *
 * SUPER_ADMIN is always treated as group-wide (belt and braces), so the very
 * top role can never accidentally be locked out of the group.
 *
 * The returned value is either the string 'ALL' (no company filter) or an array
 * of company ids to constrain queries by.
 */
export async function accessibleCompanyIds(user) {
  if (!user) return [];
  if (user.role === 'SUPER_ADMIN' || user.allCompanies) return 'ALL';

  // Load the explicit access set if it wasn't included on the user object.
  let ids = Array.isArray(user.companies) ? user.companies.map((c) => c.id) : null;
  if (ids === null) {
    const full = await prisma.user.findUnique({
      where: { id: user.id },
      select: { companyId: true, companies: { select: { id: true } } },
    });
    ids = (full?.companies || []).map((c) => c.id);
    if (full?.companyId) ids.push(full.companyId);
  } else if (user.companyId) {
    ids.push(user.companyId);
  }
  return Array.from(new Set(ids.filter(Boolean)));
}

/**
 * Build a Prisma `where` fragment that limits a query by company.
 * @param {Object} user
 * @param {string} [field='companyId'] the column on the model to filter
 * @returns {Promise<Object>} e.g. {} for all-access, or { companyId: { in: [...] } }
 */
export async function companyScopeWhere(user, field = 'companyId') {
  const ids = await accessibleCompanyIds(user);
  if (ids === 'ALL') return {};
  if (!ids.length) return { [field]: { in: ['__none__'] } }; // scoped user with no companies → sees nothing
  return { [field]: { in: ids } };
}

/** True if a user may act on a specific company id. */
export async function canAccessCompany(user, companyId) {
  if (!companyId) return true; // unassigned records aren't company-restricted
  const ids = await accessibleCompanyIds(user);
  if (ids === 'ALL') return true;
  return ids.includes(companyId);
}

/** Staff shortcut used widely in controllers. */
export const isStaff = (user) => !!user && ROLE_RANK[user.role] >= ROLE_RANK.ICT_TECHNICIAN;
