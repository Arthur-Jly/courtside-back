const express = require('express');
const { requireAuth, requireClubAdmin } = require('../middleware/auth');

module.exports = function(db){
	const router = express.Router();
	const controller = require('../controllers/slots.controller')(db);

	// public: list slots for a terrain
	router.get('/terrains/:id/slots', controller.listSlots);

	// public: list slots for a club
	router.get('/clubs/:id/slots', controller.listSlotsByClub);

	// book a slot (requires auth)
	router.post('/slots/:id/book', requireAuth, controller.bookSlot);

	// cancel reservation (requires auth)
	router.post('/reservations/:id/cancel', requireAuth, controller.cancelReservation);

	// admin routes (require auth + club_admin role)
	router.post('/admin/generate-slots', requireAuth, requireClubAdmin, controller.adminGenerateSlots);
	router.post('/admin/generate-slots/terrain', requireAuth, requireClubAdmin, controller.adminGenerateSlotsForTerrain);
	router.post('/admin/generate-slots/club', requireAuth, requireClubAdmin, controller.adminGenerateSlotsForClub);
	router.delete('/admin/slots/cleanup', requireAuth, requireClubAdmin, controller.adminCleanupSlots);
	router.post('/admin/remove-duplicate-slots', requireAuth, requireClubAdmin, controller.adminRemoveDuplicateSlots);
	router.post('/admin/truncate-slots', requireAuth, requireClubAdmin, controller.adminTruncateSlots);

	return router;
};
