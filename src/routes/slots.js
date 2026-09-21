const express = require('express');
const { requireAuth, requireClubAdmin, requireOwnClub } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { validate, schemas } = require('../middleware/validation');

module.exports = function (db) {
  const router = express.Router();
  const controller = require('../controllers/slots.controller')(db);

  router.get('/terrains/:id/slots', validate(schemas.slotListQuery, 'query'), asyncHandler(controller.listSlots));
  router.get('/clubs/:id/slots', validate(schemas.slotListQuery, 'query'), asyncHandler(controller.listSlotsByClub));
  router.get('/clubs/:id/occupancy', requireAuth, requireOwnClub('id'), asyncHandler(controller.clubOccupancy));

  router.post('/slots/:id/book', requireAuth, validate(schemas.bookSlot), asyncHandler(controller.bookSlot));
  router.post('/reservations/:id/cancel', requireAuth, asyncHandler(controller.cancelReservation));

  // Admin routes — scope enforcement is done INSIDE each controller (uses req.user.club_id).
  router.post('/admin/generate-slots', requireAuth, requireClubAdmin, validate(schemas.generateSlots), asyncHandler(controller.adminGenerateSlots));
  router.post('/admin/generate-slots/terrain', requireAuth, requireClubAdmin, validate(schemas.generateSlotsForTerrain), asyncHandler(controller.adminGenerateSlotsForTerrain));
  router.post('/admin/generate-slots/club', requireAuth, requireClubAdmin, validate(schemas.generateSlotsForClub), asyncHandler(controller.adminGenerateSlotsForClub));
  router.delete('/admin/slots/cleanup', requireAuth, requireClubAdmin, validate(schemas.cleanupSlots), asyncHandler(controller.adminCleanupSlots));
  router.post('/admin/remove-duplicate-slots', requireAuth, requireClubAdmin, asyncHandler(controller.adminRemoveDuplicateSlots));
  router.post('/admin/truncate-slots', requireAuth, requireClubAdmin, asyncHandler(controller.adminTruncateSlots));
  router.post('/admin/slots/block', requireAuth, requireClubAdmin, validate(schemas.blockSlot), asyncHandler(controller.adminBlockSlot));
  router.delete('/admin/slots/:id/block', requireAuth, requireClubAdmin, asyncHandler(controller.adminUnblockSlot));

  return router;
};
