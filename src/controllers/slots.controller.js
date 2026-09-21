const { poolOf, queryPromise, queryOne } = require('../utils/dbHelpers');
const { logger } = require('../utils/logger');
const {
  AppError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  ValidationError,
} = require('../middleware/errorHandler');
const { formatLocalYmd, timeToMinutes, todayLocalYmd, addDaysYmd } = require('../utils/dates');
const config = require('../config');

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_GENERATION_DAYS = 366;

// Une plage non bornée (toDate=2999-12-31) bouclait sur des centaines de milliers
// de jours et saturait la mémoire du process pour un simple POST de gérant.
function assertValidRange(fromDate, toDate) {
  if (!YMD.test(String(fromDate)) || !YMD.test(String(toDate)) || toDate < fromDate) {
    throw new ValidationError('Plage de dates invalide');
  }
  const days = (new Date(`${toDate}T00:00:00Z`) - new Date(`${fromDate}T00:00:00Z`)) / 86400000;
  if (days > MAX_GENERATION_DAYS) {
    throw new ValidationError(`Plage de dates trop large (${MAX_GENERATION_DAYS} jours maximum)`);
  }
}

module.exports = function (db) {
  const pool = poolOf(db);

  async function generateSlotsForTerrain(terrainId, fromDate, toDate, slotDurationMinutes) {
    assertValidRange(fromDate, toDate);
    const recs = await queryPromise(
      db,
      'SELECT id, day_of_week, start_time, end_time, is_closed FROM recurring_availabilities WHERE terrain_id = ?',
      [terrainId],
    );

    const terrainRow = await queryOne(db, 'SELECT club_id FROM `terrains` WHERE id = ?', [terrainId]);
    let clubId = terrainRow ? terrainRow.club_id : null;

    let durationMinutes = slotDurationMinutes;
    if (!durationMinutes) {
      const tInfo = await queryOne(db, 'SELECT slot_duration FROM `terrains` WHERE id = ?', [terrainId]);
      durationMinutes = Number(tInfo?.slot_duration) || config.slots.defaultDurationMinutes;
    }

    const exRows = await queryPromise(
      db,
      "SELECT id, DATE_FORMAT(date, '%Y-%m-%d') AS date_str, is_closed, special_open_time, special_close_time FROM availability_exceptions WHERE terrain_id = ?",
      [terrainId],
    );
    const exs = exRows.reduce((acc, e) => { acc[e.date_str] = e; return acc; }, {});

    const existingRows = await queryPromise(
      db,
      "SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date_str, start_time, end_time FROM slots WHERE terrain_id = ? AND DATE(date) BETWEEN ? AND ?",
      [terrainId, fromDate, toDate],
    );
    const existingByDate = {};
    existingRows.forEach((r) => {
      const key = r.date_str || String(r.date);
      const sMin = timeToMinutes(r.start_time);
      const eMin = timeToMinutes(r.end_time);
      existingByDate[key] = existingByDate[key] || [];
      existingByDate[key].push({ sMin, eMin });
    });

    const slotsToInsert = [];
    const dayMs = 24 * 60 * 60 * 1000;
    const startDate = new Date(fromDate + 'T00:00:00Z');
    const endDate = new Date(toDate + 'T00:00:00Z');
    for (let d = new Date(startDate); d.getTime() <= endDate.getTime(); d = new Date(d.getTime() + dayMs)) {
      const isoDate = d.toISOString().slice(0, 10);
      const exception = exs[isoDate];
      if (exception && exception.is_closed) continue;

      // `d` est à minuit UTC : getDay() (fuseau local) donnait la veille sur un serveur à l'ouest de UTC.
      const dow = d.getUTCDay();
      for (const r of recs) {
        if (r.is_closed) continue;
        if (Number(r.day_of_week) !== dow) continue;

        const start = (exception && exception.special_open_time) ? exception.special_open_time : r.start_time;
        const end = (exception && exception.special_close_time) ? exception.special_close_time : r.end_time;

        let cur = timeToMinutes(start);
        const endM = timeToMinutes(end);
        while (cur + durationMinutes <= endM) {
          const sh = String(Math.floor(cur / 60)).padStart(2, '0') + ':' + String(cur % 60).padStart(2, '0');
          const ehMin = cur + durationMinutes;
          const eh = String(Math.floor(ehMin / 60)).padStart(2, '0') + ':' + String(ehMin % 60).padStart(2, '0');

          const existing = existingByDate[isoDate] || [];
          const overlaps = existing.some((ex) => ex.sMin < ehMin && ex.eMin > cur);
          if (!overlaps) {
            slotsToInsert.push([terrainId, clubId, isoDate, sh, eh, 'free']);
          }
          cur += durationMinutes;
        }
      }
    }

    if (slotsToInsert.length === 0) return { inserted: 0 };

    if (clubId == null) {
      logger.warn(`generateSlotsForTerrain: terrain ${terrainId} has no club_id, fallback 0`);
      clubId = 0;
      for (const row of slotsToInsert) row[1] = clubId;
    }

    const valuesSql = slotsToInsert.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    const flat = slotsToInsert.flat();
    try {
      const result = await queryPromise(
        db,
        `INSERT IGNORE INTO slots (terrain_id, club_id, date, start_time, end_time, status) VALUES ${valuesSql}`,
        flat,
      );
      return { inserted: result?.affectedRows || 0 };
    } catch (err) {
      logger.error(`Error inserting slots: ${err.message}`);
      return { inserted: 0, error: err.message };
    }
  }

  async function adminGenerateSlots(req, res) {
    const adminClubId = req.user && req.user.club_id;
    if (!adminClubId) throw new ForbiddenError('club admin scope required');

    const daysRaw = Object.prototype.hasOwnProperty.call(req.body, 'days') ? req.body.days : undefined;
    const weeksRaw = Object.prototype.hasOwnProperty.call(req.body, 'weeks') ? req.body.weeks : undefined;
    const days = typeof daysRaw !== 'undefined' ? Number(daysRaw) : null;
    const weeks = typeof weeksRaw !== 'undefined' ? Number(weeksRaw) : null;
    const fromDate = req.body.fromDate || todayLocalYmd();
    let toDate;
    if (req.body.toDate) toDate = req.body.toDate;
    else if (days !== null) toDate = addDaysYmd(fromDate, days);
    else if (weeks !== null) toDate = addDaysYmd(fromDate, weeks * 7);
    else toDate = addDaysYmd(fromDate, config.slots.defaultGenerationWeeks * 7);

    const terrains = await queryPromise(db, 'SELECT id FROM `terrains` WHERE club_id = ?', [adminClubId]);
    let totalInserted = 0;
    for (const t of terrains) {
      const r = await generateSlotsForTerrain(t.id, fromDate, toDate);
      totalInserted += r.inserted || 0;
    }

    res.json({ ok: true, fromDate, toDate, totalInserted });
  }

  async function adminGenerateSlotsForTerrain(req, res) {
    const terrainId = Number(req.body.terrain_id);
    if (!Number.isFinite(terrainId)) throw new ValidationError('terrain_id requis');

    const t = await queryOne(db, 'SELECT club_id FROM terrains WHERE id = ?', [terrainId]);
    if (!t) throw new NotFoundError('Terrain introuvable');
    if (Number(t.club_id) !== Number(req.user.club_id)) throw new ForbiddenError();

    const weeksRaw = Object.prototype.hasOwnProperty.call(req.body, 'weeks') ? req.body.weeks : undefined;
    const weeks = typeof weeksRaw !== 'undefined' ? Number(weeksRaw) : null;
    const fromDate = req.body.fromDate || todayLocalYmd();
    let toDate = req.body.toDate;
    if (typeof toDate === 'undefined' || toDate === null) {
      toDate = addDaysYmd(fromDate, (weeks !== null ? weeks : config.slots.defaultGenerationWeeks) * 7);
    }
    const r = await generateSlotsForTerrain(terrainId, fromDate, toDate);
    res.json({ ok: true, terrainId, fromDate, toDate, inserted: r.inserted });
  }

  async function adminGenerateSlotsForClub(req, res) {
    const clubId = Number(req.body.club_id);
    if (!Number.isFinite(clubId)) throw new ValidationError('club_id requis');
    if (Number(req.user.club_id) !== clubId) throw new ForbiddenError();

    const weeksRaw = Object.prototype.hasOwnProperty.call(req.body, 'weeks') ? req.body.weeks : undefined;
    const weeks = typeof weeksRaw !== 'undefined' ? Number(weeksRaw) : null;
    const fromDate = req.body.fromDate || todayLocalYmd();
    let toDate = req.body.toDate;
    if (typeof toDate === 'undefined' || toDate === null) {
      toDate = addDaysYmd(fromDate, (weeks !== null ? weeks : config.slots.defaultGenerationWeeks) * 7);
    }

    const terrains = await queryPromise(db, 'SELECT id FROM `terrains` WHERE club_id = ?', [clubId]);
    let totalInserted = 0;
    for (const t of terrains) {
      const r = await generateSlotsForTerrain(t.id, fromDate, toDate);
      totalInserted += r.inserted || 0;
    }
    res.json({ ok: true, clubId, fromDate, toDate, totalInserted, terrains: terrains.map((t) => t.id) });
  }

  async function listSlots(req, res) {
    const terrainId = Number(req.params.id);
    if (!Number.isFinite(terrainId)) throw new ValidationError('id invalide');
    const { date, status } = req.query;
    const params = [terrainId];
    let sql = `
      SELECT s.*, t.name AS terrain_name, t.sport_type, t.club_id
      FROM slots s
      JOIN terrains t ON s.terrain_id = t.id
      WHERE s.terrain_id = ?
        AND s.date >= CURDATE()
    `;
    if (date) { sql += ' AND DATE(s.date) = ?'; params.push(date); }
    if (status) { sql += ' AND s.status = ?'; params.push(status); }
    sql += ' ORDER BY s.date, s.start_time';
    const rows = await queryPromise(db, sql, params);
    res.json(rows);
  }

  async function listSlotsByClub(req, res) {
    const clubId = Number(req.params.id);
    if (!Number.isFinite(clubId)) throw new ValidationError('id invalide');
    const { date, status } = req.query;
    const params = [clubId];
    let sql = `
      SELECT s.*, t.name AS terrain_name, t.sport_type, t.club_id
      FROM slots s
      JOIN terrains t ON s.terrain_id = t.id
      WHERE t.club_id = ?
        AND s.date >= CURDATE()
    `;
    if (date) { sql += ' AND DATE(s.date) = ?'; params.push(date); }
    const effectiveStatus = status || 'free';
    if (effectiveStatus !== 'all') { sql += ' AND s.status = ?'; params.push(effectiveStatus); }
    sql += ' ORDER BY s.date, s.start_time, t.name';
    const rows = await queryPromise(db, sql, params);
    logger.debug(`listSlotsByClub club=${clubId} rows=${rows.length}`);
    res.json(rows);
  }

  async function bookSlot(req, res) {
    // Cette route crée une réservation confirmée SANS paiement : n'importe quel
    // joueur connecté pouvait réserver gratuitement (et fixer son propre prix).
    // Le parcours normal passe par Stripe Checkout (payments/create-checkout-session).
    if (!config.allowDirectBooking) {
      throw new ForbiddenError('La réservation directe est désactivée : utilisez le paiement en ligne.');
    }
    const slotId = Number(req.params.id);
    if (!Number.isFinite(slotId)) throw new ValidationError('id invalide');
    const userId = req.user && req.user.id;
    if (!userId) throw new AppError('authentication required', 401);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [srows] = await conn.query(
        `SELECT s.status, s.date, s.start_time, s.end_time, s.terrain_id, t.price_per_hour
         FROM slots s JOIN terrains t ON t.id = s.terrain_id
         WHERE s.id = ? FOR UPDATE OF s`,
        [slotId],
      );
      const row = srows && srows[0];
      if (!row) throw new NotFoundError('Créneau introuvable');
      if (row.status !== 'free') throw new ConflictError('Créneau non disponible');

      // Prix = tarif du terrain × durée du créneau, jamais une valeur du client.
      const hours = (timeToMinutes(row.end_time) - timeToMinutes(row.start_time)) / 60;
      const price = Math.round(Number(row.price_per_hour) * hours * 100) / 100;
      const day = formatLocalYmd(row.date);

      const [rres] = await conn.query(
        'INSERT INTO reservations (user_id, terrain_id, start_time, end_time, price, status) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, row.terrain_id, `${day} ${row.start_time}`, `${day} ${row.end_time}`, price, 'confirmed'],
      );
      const reservationId = rres && (rres.insertId || rres.insert_id);
      if (!reservationId) throw new AppError('Impossible de créer la réservation', 500);

      await conn.query(
        'UPDATE slots SET status = ?, reservation_id = ? WHERE id = ?',
        ['booked', reservationId, slotId],
      );
      await conn.commit();
      res.json({ ok: true, reservationId });
    } catch (err) {
      try { await conn.rollback(); } catch (rbErr) { logger.error(`bookSlot rollback failed: ${rbErr.message}`); }
      throw err;
    } finally {
      conn.release();
    }
  }

  async function cancelReservation(req, res) {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) throw new ValidationError('id invalide');
    const userId = req.user && req.user.id;
    if (!userId) throw new AppError('authentication required', 401);

    const row = await queryOne(db, 'SELECT id, status, user_id, terrain_id FROM reservations WHERE id = ?', [reservationId]);
    if (!row) throw new NotFoundError('Réservation introuvable');

    const isOwner = Number(row.user_id) === Number(userId);
    let isClubAdmin = false;
    if (req.user.role === 'club_admin' && req.user.club_id) {
      const t = await queryOne(db, 'SELECT club_id FROM terrains WHERE id = ?', [row.terrain_id]);
      isClubAdmin = t && Number(t.club_id) === Number(req.user.club_id);
    }
    if (!isOwner && !isClubAdmin) throw new ForbiddenError();
    if (row.status !== 'active' && row.status !== 'confirmed') throw new ConflictError('Annulation impossible');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('UPDATE reservations SET status = ? WHERE id = ?', ['cancelled', reservationId]);
      await conn.query('UPDATE slots SET status = ?, reservation_id = NULL WHERE reservation_id = ?', ['free', reservationId]);
      await conn.commit();
      res.json({ ok: true });
    } catch (err) {
      try { await conn.rollback(); } catch (rbErr) { logger.error(`cancelReservation rollback failed: ${rbErr.message}`); }
      throw err;
    } finally {
      conn.release();
    }
  }

  async function adminCleanupSlots(req, res) {
    const adminClubId = req.user && req.user.club_id;
    if (!adminClubId) throw new ForbiddenError('club admin scope required');
    const keepDays = Number(req.body.keepDays || config.slots.cleanupDefaultKeepDays);
    if (!Number.isFinite(keepDays) || keepDays < 1 || keepDays > 3650) {
      throw new ValidationError('keepDays invalide (1-3650)');
    }
    const cutoff = addDaysYmd(todayLocalYmd(), -keepDays);
    // Les créneaux réservés portent l'historique (réservations, exports compta) : jamais purgés ici.
    await queryPromise(db, "DELETE FROM slots WHERE date < ? AND club_id = ? AND status <> 'booked'", [cutoff, adminClubId]);
    res.json({ ok: true, cutoff });
  }

  async function adminRemoveDuplicateSlots(req, res) {
    const adminClubId = req.user && req.user.club_id;
    if (!adminClubId) throw new ForbiddenError('club admin scope required');
    const result = await queryPromise(db, `
      DELETE s1 FROM slots s1
      INNER JOIN slots s2
        ON s1.terrain_id = s2.terrain_id
        AND s1.date = s2.date
        AND s1.start_time = s2.start_time
        AND s1.id > s2.id
      WHERE s1.club_id = ?
    `, [adminClubId]);
    res.json({ ok: true, deleted: result?.affectedRows ?? 0 });
  }

  async function adminTruncateSlots(req, res) {
    const adminClubId = req.user && req.user.club_id;
    if (!adminClubId) throw new ForbiddenError('club admin scope required');
    // Les créneaux réservés ou tenus par une annonce ne se suppriment pas : on orphelinerait des clients qui ont payé.
    const result = await queryPromise(db, "DELETE FROM slots WHERE club_id = ? AND status IN ('free', 'blocked')", [adminClubId]);
    res.json({ ok: true, deleted: result?.affectedRows ?? 0 });
  }

  async function adminBlockSlot(req, res) {
    const adminClubId = req.user && req.user.club_id;
    if (!adminClubId) throw new ForbiddenError('club admin scope required');
    const terrainId = Number(req.body.terrain_id);
    const date = req.body.date;
    const startTime = req.body.start_time;
    const endTime = req.body.end_time;
    if (!Number.isFinite(terrainId) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^\d{2}:\d{2}/.test(String(startTime))) {
      throw new ValidationError('terrain_id, date, start_time requis');
    }

    const t = await queryOne(db, 'SELECT club_id FROM terrains WHERE id = ?', [terrainId]);
    if (!t || Number(t.club_id) !== Number(adminClubId)) throw new ForbiddenError();

    const start = String(startTime).slice(0, 5) + ':00';
    const end = endTime ? String(endTime).slice(0, 5) + ':00' : null;

    const existing = await queryOne(
      db,
      'SELECT id, status FROM slots WHERE terrain_id = ? AND date = ? AND start_time = ? LIMIT 1',
      [terrainId, date, start],
    );
    if (existing) {
      if (existing.status === 'booked') throw new ConflictError('Ce créneau est déjà réservé');
      await queryPromise(db, "UPDATE slots SET status = 'blocked' WHERE id = ?", [existing.id]);
      return res.json({ ok: true, slot_id: existing.id, blocked: true });
    }
    const result = await queryPromise(
      db,
      "INSERT INTO slots (terrain_id, club_id, date, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, 'blocked')",
      [terrainId, adminClubId, date, start, end || start],
    );
    res.status(201).json({ ok: true, slot_id: result.insertId, blocked: true });
  }

  async function adminUnblockSlot(req, res) {
    const adminClubId = req.user && req.user.club_id;
    if (!adminClubId) throw new ForbiddenError('club admin scope required');
    const slotId = Number(req.params.id);
    if (!Number.isFinite(slotId)) throw new ValidationError('id invalide');
    const row = await queryOne(db, 'SELECT club_id, status FROM slots WHERE id = ?', [slotId]);
    if (!row || Number(row.club_id) !== Number(adminClubId)) throw new ForbiddenError();
    if (row.status !== 'blocked') throw new ValidationError("Ce créneau n'est pas bloqué");
    await queryPromise(db, "UPDATE slots SET status = 'free' WHERE id = ?", [slotId]);
    res.json({ ok: true, freed: true });
  }

  async function clubOccupancy(req, res) {
    const clubId = Number(req.params.id);
    if (!Number.isFinite(clubId)) throw new ValidationError('club_id invalide');
    const rows = await queryPromise(db, `
      SELECT DATE_FORMAT(s.date, '%Y-%m-%d') AS day,
             COUNT(*) AS total,
             SUM(s.status = 'booked') AS booked
      FROM slots s
      JOIN terrains t ON t.id = s.terrain_id
      WHERE t.club_id = ?
        AND s.date >= CURDATE()
        AND s.date < DATE_ADD(CURDATE(), INTERVAL 7 DAY)
      GROUP BY DATE(s.date)
      ORDER BY day
    `, [clubId]);
    res.json(rows.map((r) => ({
      day: r.day,
      total: Number(r.total),
      booked: Number(r.booked || 0),
      rate: Number(r.total) > 0 ? Math.round((Number(r.booked || 0) / Number(r.total)) * 100) : 0,
    })));
  }

  return {
    adminGenerateSlots,
    adminGenerateSlotsForTerrain,
    adminGenerateSlotsForClub,
    adminRemoveDuplicateSlots,
    adminTruncateSlots,
    adminBlockSlot,
    adminUnblockSlot,
    clubOccupancy,
    listSlots,
    listSlotsByClub,
    bookSlot,
    cancelReservation,
    adminCleanupSlots,
    generateSlotsForTerrain,
  };
};
