const express = require('express');

module.exports = function(db){
	const router = express.Router();
	const controller = require('../controllers/slots.controller')(db);

	// public: list slots for a terrain
	router.get('/terrains/:id/slots', controller.listSlots);

	// public: list slots for a club
	router.get('/clubs/:id/slots', controller.listSlotsByClub);

	// book a slot
	router.post('/slots/:id/book', controller.bookSlot);

	// cancel reservation
	router.post('/reservations/:id/cancel', controller.cancelReservation);

	// admin: generate slots
	router.post('/admin/generate-slots', controller.adminGenerateSlots);

	// admin: generate slots for a single terrain
	router.post('/admin/generate-slots/terrain', controller.adminGenerateSlotsForTerrain);

	// admin: generate slots for all terrains of a club
	router.post('/admin/generate-slots/club', controller.adminGenerateSlotsForClub);

	// admin: cleanup old slots
	router.delete('/admin/slots/cleanup', controller.adminCleanupSlots);

	// admin: remove duplicate slots
	router.post('/admin/remove-duplicate-slots', controller.adminRemoveDuplicateSlots);

	// admin: truncate slots table
	router.post('/admin/truncate-slots', controller.adminTruncateSlots);

	return router;
};
