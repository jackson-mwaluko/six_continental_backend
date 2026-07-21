import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';
import { notify } from '../services/notification.service.js';

// Recomputes project progress from task completion (% of tasks done).
async function recomputeProgress(tx, projectId) {
  const tasks = await tx.projectTask.findMany({ where: { projectId } });
  const done = tasks.filter((t) => t.status === 'DONE').length;
  const progress = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  await tx.project.update({ where: { id: projectId }, data: { progress } });
  return progress;
}

// GET /api/projects
export const listProjects = asyncHandler(async (req, res) => {
  const { search, status } = req.query;
  const projects = await prisma.project.findMany({
    where: {
      ...(status && { status }),
      ...(search && { OR: [{ name: { contains: search, mode: 'insensitive' } }, { code: { contains: search, mode: 'insensitive' } }] }),
    },
    include: { lead: { select: { firstName: true, lastName: true } }, _count: { select: { tasks: true, milestones: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: projects });
});

// GET /api/projects/:id — board view: tasks grouped + milestones
export const getProject = asyncHandler(async (req, res) => {
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    include: {
      lead: { select: { id: true, firstName: true, lastName: true } },
      milestones: { orderBy: { dueDate: 'asc' } },
      tasks: { include: { assignee: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!project) throw ApiError.notFound('Project not found');

  const board = { TODO: [], IN_PROGRESS: [], REVIEW: [], DONE: [] };
  project.tasks.forEach((t) => { (board[t.status] || (board[t.status] = [])).push(t); });

  res.json({ success: true, data: { ...project, board } });
});

// POST /api/projects
export const createProject = asyncHandler(async (req, res) => {
  const { name, code, description, status, startDate, endDate, leadId } = req.body;
  const project = await prisma.project.create({
    data: {
      name, code: code || null, description: description || null,
      status: status || 'PLANNING', leadId: leadId || null,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
    },
  });
  await logActivity({ userId: req.user.id, action: 'CREATE', entity: 'Project', entityId: project.id });
  res.status(201).json({ success: true, data: project });
});

// POST /api/projects/:id/tasks
export const addTask = asyncHandler(async (req, res) => {
  const { title, description, assigneeId, dueDate } = req.body;
  const task = await prisma.projectTask.create({
    data: {
      projectId: req.params.id, title, description: description || null,
      assigneeId: assigneeId || null, dueDate: dueDate ? new Date(dueDate) : null,
    },
    include: { assignee: { select: { id: true, firstName: true, lastName: true } } },
  });
  await prisma.$transaction((tx) => recomputeProgress(tx, req.params.id));
  if (task.assigneeId && task.assigneeId !== req.user.id) {
    const project = await prisma.project.findUnique({ where: { id: req.params.id }, select: { name: true } });
    await notify({
      userId: task.assigneeId, type: 'SYSTEM',
      title: 'New task assigned to you',
      message: `${task.title}${project ? ` · ${project.name}` : ''}`,
      link: `/projects/${req.params.id}`, email: false,
    });
  }
  res.status(201).json({ success: true, data: task });
});

// PATCH /api/tasks/:id — move across the board / edit
export const updateTask = asyncHandler(async (req, res) => {
  const existing = await prisma.projectTask.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Task not found');

  const data = {};
  for (const k of ['title', 'description', 'status', 'assigneeId']) if (req.body[k] !== undefined) data[k] = req.body[k];
  if (req.body.dueDate !== undefined) data.dueDate = req.body.dueDate ? new Date(req.body.dueDate) : null;

  const task = await prisma.projectTask.update({ where: { id: req.params.id }, data, include: { assignee: { select: { id: true, firstName: true, lastName: true } } } });
  await prisma.$transaction((tx) => recomputeProgress(tx, existing.projectId));
  if (data.assigneeId && data.assigneeId !== existing.assigneeId && data.assigneeId !== req.user.id) {
    await notify({
      userId: data.assigneeId, type: 'SYSTEM',
      title: 'A task was assigned to you',
      message: task.title, link: `/projects/${existing.projectId}`, email: false,
    });
  }
  res.json({ success: true, data: task });
});

// POST /api/projects/:id/milestones
export const addMilestone = asyncHandler(async (req, res) => {
  const { title, dueDate } = req.body;
  const milestone = await prisma.milestone.create({
    data: { projectId: req.params.id, title, dueDate: dueDate ? new Date(dueDate) : null },
  });
  res.status(201).json({ success: true, data: milestone });
});

// PATCH /api/milestones/:id — toggle complete / edit
export const updateMilestone = asyncHandler(async (req, res) => {
  const milestone = await prisma.milestone.update({ where: { id: req.params.id }, data: req.body });
  res.json({ success: true, data: milestone });
});

// DELETE /api/projects/:id — remove a project and its tasks/milestones
export const deleteProject = asyncHandler(async (req, res) => {
  const existing = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Project not found');
  await prisma.$transaction([
    prisma.projectTask.deleteMany({ where: { projectId: req.params.id } }),
    prisma.milestone.deleteMany({ where: { projectId: req.params.id } }),
    prisma.project.delete({ where: { id: req.params.id } }),
  ]);
  await logActivity({ userId: req.user.id, action: 'DELETE', entity: 'Project', entityId: req.params.id, metadata: { name: existing.name } });
  res.json({ success: true, message: 'Project deleted' });
});

// DELETE /api/tasks/:id
export const deleteTask = asyncHandler(async (req, res) => {
  const existing = await prisma.projectTask.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Task not found');
  await prisma.projectTask.delete({ where: { id: req.params.id } });
  await prisma.$transaction((tx) => recomputeProgress(tx, existing.projectId));
  await logActivity({ userId: req.user.id, action: 'DELETE', entity: 'ProjectTask', entityId: req.params.id });
  res.json({ success: true, message: 'Task deleted' });
});
