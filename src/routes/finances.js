const express = require('express');

module.exports = function(db){
  const router = express.Router();
  const controller = require('../controllers/finances.controller')(db);

  // Get financial data for a club
  router.get('/clubs/:id/finances', controller.getClubFinances);

  return router;
};
