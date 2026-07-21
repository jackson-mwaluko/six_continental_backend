import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';

const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// GET /api/knowledge — search by text, filter by category/tag, list categories+tags
export const listArticles = asyncHandler(async (req, res) => {
  const { search, category, tag, page, limit } = req.query;
  const where = {
    isPublished: true,
    ...(category && { category }),
    ...(tag && { tags: { has: tag } }),
    ...(search && {
      OR: [
        { title: { contains: search, mode: 'insensitive' } },
        { body: { contains: search, mode: 'insensitive' } },
      ],
    }),
  };

  // Opt-in pagination: only applied when page & limit are provided.
  const take = limit ? Number(limit) : undefined;
  const skip = page && limit ? (Number(page) - 1) * Number(limit) : undefined;

  const [articles, total] = await Promise.all([
    prisma.knowledgeArticle.findMany({
      where, skip, take,
      include: { author: { select: { firstName: true, lastName: true } } },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.knowledgeArticle.count({ where }),
  ]);

  // Facets for the sidebar filters.
  const all = await prisma.knowledgeArticle.findMany({ where: { isPublished: true }, select: { category: true, tags: true } });
  const categories = [...new Set(all.map((a) => a.category))].sort();
  const tags = [...new Set(all.flatMap((a) => a.tags))].sort();

  res.json({ success: true, data: articles, meta: { categories, tags, total, page: page ? Number(page) : 1 } });
});

// GET /api/knowledge/:id — fetch one and increment views
export const getArticle = asyncHandler(async (req, res) => {
  const article = await prisma.knowledgeArticle.findUnique({
    where: { id: req.params.id },
    include: { author: { select: { firstName: true, lastName: true } } },
  });
  if (!article) throw ApiError.notFound('Article not found');
  await prisma.knowledgeArticle.update({ where: { id: article.id }, data: { views: { increment: 1 } } });
  res.json({ success: true, data: { ...article, views: article.views + 1 } });
});

// POST /api/knowledge
export const createArticle = asyncHandler(async (req, res) => {
  const { title, body, category, tags } = req.body;
  const baseSlug = slugify(title);
  const exists = await prisma.knowledgeArticle.findUnique({ where: { slug: baseSlug } });
  const slug = exists ? `${baseSlug}-${Date.now().toString(36)}` : baseSlug;

  const article = await prisma.knowledgeArticle.create({
    data: {
      title, body, category: category || 'General', slug,
      tags: Array.isArray(tags) ? tags : (tags ? String(tags).split(',').map((t) => t.trim()).filter(Boolean) : []),
      authorId: req.user.id,
    },
  });
  await logActivity({ userId: req.user.id, action: 'CREATE', entity: 'KnowledgeArticle', entityId: article.id });
  res.status(201).json({ success: true, data: article });
});

// PATCH /api/knowledge/:id
export const updateArticle = asyncHandler(async (req, res) => {
  const data = { ...req.body };
  if (data.tags && !Array.isArray(data.tags)) data.tags = String(data.tags).split(',').map((t) => t.trim()).filter(Boolean);
  delete data.slug; delete data.authorId;
  const article = await prisma.knowledgeArticle.update({ where: { id: req.params.id }, data });
  res.json({ success: true, data: article });
});

// DELETE /api/knowledge/:id
export const deleteArticle = asyncHandler(async (req, res) => {
  await prisma.knowledgeArticle.delete({ where: { id: req.params.id } });
  await logActivity({ userId: req.user.id, action: 'DELETE', entity: 'KnowledgeArticle', entityId: req.params.id });
  res.json({ success: true, message: 'Article deleted' });
});
