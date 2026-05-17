const express = require('express');
const { requireAuth, requireClubAdmin } = require('../middleware/auth');

module.exports = function (db) {
  const router = express.Router();
  const controller = require('../controllers/slots.controller')(db);

  router.get('/terrains/:id/slots', controller.listSlots);
  router.get('/clubs/:id/slots', controller.listSlotsByClub);

  router.post('/slots/:id/book', requireAuth, controller.bookSlot);
  router.post('/reservations/:id/cancel', requireAuth, controller.cancelReservation);

  // Admin routes — scope enforcement is done INSIDE each controller (uses req.user.club_id).
  router.post('/admin/generate-slots', requireAuth, requireClubAdmin, controller.adminGenerateSlots);
  router.post('/admin/generate-slots/terrain', requireAuth, requireClubAdmin, controller.adminGenerateSlotsForTerrain);
  router.post('/admin/generate-slots/club', requireAuth, requireClubAdmin, controller.adminGenerateSlotsForClub);
  router.delete('/admin/slots/cleanup', requireAuth, requireClubAdmin, controller.adminCleanupSlots);
  router.post('/admin/remove-duplicate-slots', requireAuth, requireClubAdmin, controller.adminRemoveDuplicateSlots);
  router.post('/admin/truncate-slots', requireAuth, requireClubAdmin, controller.adminTruncateSlots);

  return router;
};
