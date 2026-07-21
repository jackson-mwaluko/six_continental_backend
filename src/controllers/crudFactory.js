import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';

/**
 * Builds a standard list/get/create/update/delete controller for a Prisma model.
 * Used by the modules whose logic is straightforward CRUD so we avoid
 * repeating boilerplate. Specialised modules (tickets, assets, assignments)
 * keep their own controllers.
 *
 * @param {string} model        Prisma model name (e.g. 'subscription')
 * @param {object} options
 * @param {string[]} options.searchFields  fields to match against ?search
 * @param {object}   options.include       Prisma include for relations
 * @param {string}   options.entity        label used in the activity log
 */
export function crudController(model, { searchFields = [], include = undefined, entity } = {}) {
  const label = entity || model;
  const delegate = prisma[model];

  return {
    list: asyncHandler(async (req, res) => {
      const { search, page = 1, limit = 25, ...filters } = req.query;
      const skip = (Number(page) - 1) * Number(limit);

      // Only allow filtering on scalar query params (drop pagination keys).
      const where = {};
      for (const [k, v] of Object.entries(filters)) {
        if (v !== undefined && v !== '') where[k] = v;
      }
      if (search && searchFields.length) {
        where.OR = searchFields.map((f) => ({ [f]: { contains: search, mode: 'insensitive' } }));
      }

      const [items, total] = await Promise.all([
        delegate.findMany({ where, include, skip, take: Number(limit), orderBy: { createdAt: 'desc' } }),
        delegate.count({ where }),
      ]);
      res.json({ success: true, data: items, meta: { total, page: Number(page), limit: Number(limit) } });
    }),

    get: asyncHandler(async (req, res) => {
      const item = await delegate.findUnique({ where: { id: req.params.id }, include });
      if (!item) throw ApiError.notFound(`${label} not found`);
      res.json({ success: true, data: item });
    }),

    create: asyncHandler(async (req, res) => {
      const item = await delegate.create({ data: req.body, include });
      await logActivity({ userId: req.user?.id, action: 'CREATE', entity: label, entityId: item.id });
      res.status(201).json({ success: true, data: item });
    }),

    update: asyncHandler(async (req, res) => {
      const exists = await delegate.findUnique({ where: { id: req.params.id } });
      if (!exists) throw ApiError.notFound(`${label} not found`);
      const item = await delegate.update({ where: { id: req.params.id }, data: req.body, include });
      await logActivity({ userId: req.user?.id, action: 'UPDATE', entity: label, entityId: item.id });
      res.json({ success: true, data: item });
    }),

    remove: asyncHandler(async (req, res) => {
      await delegate.delete({ where: { id: req.params.id } });
      await logActivity({ userId: req.user?.id, action: 'DELETE', entity: label, entityId: req.params.id });
      res.json({ success: true, message: `${label} deleted` });
    }),
  };
}

export default crudController;
