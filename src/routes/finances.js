const express = require('express');
const { requireAuth, requireOwnClub } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

module.exports = function (db) {
  const router = express.Router();
  const controller = require('../controllers/finances.controller')(db);

  // Only the club admin of THIS club may see its finances.
  router.get('/clubs/:id/finances', requireAuth, requireOwnClub('id'), asyncHandler(controller.getClubFinances));

  return router;
};
