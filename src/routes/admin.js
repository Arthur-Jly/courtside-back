const express = require('express');
const AdminController = require('../controllers/admin.controller');
const MetricsController = require('../controllers/metrics.controller');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler, NotFoundError } = require('../middleware/errorHandler');

const VALID_STATUS = new Set(['attente', 'confirme', 'rejete', 'suspendu']);

module.exports = function (db, cronService) {
  const router = express.Router();
  const controller = new AdminController(db);
  const metrics = new MetricsController(db);

  // Toutes les routes /admin/* exigent un compte super-admin plateforme.
  router.use('/admin', requireAuth, requireAdmin);

  router.get('/admin/stats', asyncHandler(async (_req, res) => {
    res.json(await controller.getPlatformStats());
  }));

  // Métriques de la phase 1 : densité par ville × sport, remplissage, rétention.
  // C'est là que se lit le go/no-go des 6 semaines.
  router.get('/admin/metrics/phase1', asyncHandler(async (req, res) => {
    const { from, to, city, days } = req.query;
    res.json(await metrics.getPhase1Metrics({ from, to, city, days }));
  }));

  router.get('/admin/stats/timeseries', asyncHandler(async (req, res) => {
    const metric = ['revenue', 'reservations', 'users'].includes(req.query.metric) ? req.query.metric : 'reservations';
    const days = Number(req.query.days) || 30;
    res.json({ metric, days, series: await controller.getTimeseries(metric, days) });
  }));

  // ── Utilisateurs ────────────────────────────────────────────────────────────
  router.get('/admin/users', asyncHandler(async (req, res) => {
    const { query, role, page, limit } = req.query;
    res.json(await controller.listUsers({ query, role, page, limit }));
  }));

  router.get('/admin/users/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const user = await controller.getUserDetail(id);
    if (!user) throw new NotFoundError('Utilisateur introuvable');
    res.json({ user });
  }));

  router.put('/admin/users/:id/role', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const result = await controller.setUserRole(id, req.body?.role);
    if (result.invalid) return res.status(400).json({ error: 'rôle invalide' });
    if (result.notFound) throw new NotFoundError('Utilisateur introuvable');
    res.json(result);
  }));

  router.get('/admin/users/:id/export', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const data = await controller.exportUser(id);
    if (!data) throw new NotFoundError('Utilisateur introuvable');
    res.setHeader('Content-Disposition', `attachment; filename="courtside-user-${id}.json"`);
    res.json(data);
  }));

  router.delete('/admin/users/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    if (Number(req.user.id) === id) return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte admin' });
    const result = await controller.deleteUser(id);
    if (result.notFound) throw new NotFoundError('Utilisateur introuvable');
    if (result.forbidden) return res.status(400).json({ error: 'Impossible de supprimer un compte admin' });
    res.json({ deleted: true });
  }));

  // ── Réservations ────────────────────────────────────────────────────────────
  router.get('/admin/reservations', asyncHandler(async (req, res) => {
    const { status, club_id, from, to, page, limit } = req.query;
    res.json(await controller.listReservations({ status, clubId: club_id, from, to, page, limit }));
  }));

  // ── Finances ──────────────────────────────────────────────────────────────
  router.get('/admin/finances', asyncHandler(async (req, res) => {
    res.json(await controller.getPlatformFinances({ period: req.query.period, date: req.query.date }));
  }));

  router.get('/admin/finances/by-club', asyncHandler(async (req, res) => {
    res.json({ clubs: await controller.getFinancesByClub({ period: req.query.period, date: req.query.date }) });
  }));

  router.get('/admin/finances/export', asyncHandler(async (req, res) => {
    const rows = await controller.getFinancesRows({ from: req.query.from, to: req.query.to });
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = 'id,date,club,terrain,email,montant,statut';
    const lines = rows.map(r => [r.id, r.start_time, r.club_name, r.terrain_name, r.user_email, r.price, r.status].map(esc).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="courtside-finances.csv"');
    res.send([header, ...lines].join('\n'));
  }));

  router.get('/admin/clubs', asyncHandler(async (req, res) => {
    const status = req.query.status;
    if (status && !VALID_STATUS.has(status)) {
      return res.status(400).json({ error: 'statut invalide' });
    }
    const clubs = await controller.listClubs({ status });
    res.json({ clubs, count: clubs.length });
  }));

  router.get('/admin/clubs/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const club = await controller.getClubDetailFull(id);
    if (!club) throw new NotFoundError('Club introuvable');
    res.json({ club });
  }));

  router.put('/admin/clubs/:id/suspend', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null;
    const result = await controller.setClubSuspension(id, true, req.user.id, reason);
    if (result.notFound) throw new NotFoundError('Club introuvable');
    if (result.invalid) return res.status(400).json({ error: result.invalid });
    res.json(result);
  }));

  router.put('/admin/clubs/:id/unsuspend', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const result = await controller.setClubSuspension(id, false, req.user.id, null);
    if (result.notFound) throw new NotFoundError('Club introuvable');
    if (result.invalid) return res.status(400).json({ error: result.invalid });
    res.json(result);
  }));

  // ── Modération : sessions publiques ─────────────────────────────────────────
  router.get('/admin/announcements', asyncHandler(async (req, res) => {
    const { status, sport, page, limit } = req.query;
    res.json(await controller.listAnnouncements({ status, sport, page, limit }));
  }));

  router.put('/admin/announcements/:id/cancel', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const result = await controller.cancelAnnouncement(id);
    if (result.notFound) throw new NotFoundError('Session introuvable');
    if (result.invalid) return res.status(400).json({ error: result.invalid });
    res.json(result);
  }));

  // ── Modération : avis ───────────────────────────────────────────────────────
  router.get('/admin/reviews', asyncHandler(async (req, res) => {
    const { page, limit } = req.query;
    res.json(await controller.listReviews({ page, limit }));
  }));

  router.delete('/admin/reviews/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const result = await controller.deleteReview(id);
    if (result.notFound) throw new NotFoundError('Avis introuvable');
    res.json(result);
  }));

  // ── Activité (volumétrie messagerie — aucun contenu exposé) ─────────────────
  router.get('/admin/activity/metrics', asyncHandler(async (_req, res) => {
    res.json(await controller.getActivityMetrics());
  }));

  router.get('/admin/activity/timeseries', asyncHandler(async (req, res) => {
    const days = Number(req.query.days) || 30;
    res.json({ days, series: await controller.getMessagesTimeseries(days) });
  }));

  // ── Système : tâches planifiées ─────────────────────────────────────────────
  router.get('/admin/cron', asyncHandler(async (_req, res) => {
    if (!cronService) return res.json({ jobs: [], available: false });
    res.json({ jobs: cronService.listJobs(), available: true });
  }));

  router.post('/admin/cron/:name/run', asyncHandler(async (req, res) => {
    if (!cronService) return res.status(503).json({ error: 'Service cron indisponible' });
    const name = String(req.params.name || '');
    const known = cronService.listJobs().some(j => j.name === name);
    if (!known) throw new NotFoundError('Tâche inconnue');
    try {
      const result = await cronService.runJobManually(name);
      res.json({ ran: true, name, result: result ?? null });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }));

  router.put('/admin/clubs/:id/confirm', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const result = await controller.confirmClub(id, req.user.id);
    if (result.notFound) throw new NotFoundError('Club introuvable');
    res.json(result);
  }));

  router.put('/admin/clubs/:id/reject', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null;
    const result = await controller.rejectClub(id, req.user.id, reason);
    if (result.notFound) throw new NotFoundError('Club introuvable');
    res.json(result);
  }));

  // Renvoyer manuellement une invitation (si l'email initial n'est pas arrivé).
  router.post('/admin/clubs/:id/resend-invitation', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const club = await controller.getClubDetail(id);
    if (!club) throw new NotFoundError('Club introuvable');
    if (!club.email) return res.status(400).json({ error: 'Ce club n\'a pas d\'email de contact' });
    await controller.sendInvitation(id, club.email, club.name);
    res.json({ invitationSent: true });
  }));

  return router;
};
