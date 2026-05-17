module.exports = function(db) {
  const pool = (db && typeof db.promise === 'function') ? db.promise() : db;

// Helper: ensure date part is YYYY-MM-DD string (local timezone to avoid UTC offset)
function formatDatePart(d){
  if (!d) return null;
  // if already string in YYYY-MM-DD format
  if (typeof d === 'string'){
    const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    // try Date parse fallback — use local date parts to avoid UTC shift
    const dt = new Date(d);
    if (!isNaN(dt.getTime())) {
      const year = dt.getFullYear();
      const month = String(dt.getMonth() + 1).padStart(2, '0');
      const day = String(dt.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    return d;
  }
  if (d instanceof Date) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  // numeric timestamp
  try{
    const dt = new Date(d);
    if (!isNaN(dt.getTime())) {
      const year = dt.getFullYear();
      const month = String(dt.getMonth() + 1).padStart(2, '0');
      const day = String(dt.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  }catch(e){}
  return String(d);
}

function timeToMinutes(t){
  const parts = (t || '').split(':').map(Number);
  const h = parts[0] || 0;
  const m = parts[1] || 0;
  return h*60 + m;
}

async function generateSlotsForTerrain(terrainId, fromDate, toDate, slotDurationMinutes){
  const [raRows] = await pool.query('SELECT id, day_of_week, start_time, end_time, is_closed FROM recurring_availabilities WHERE terrain_id = ?', [terrainId]);
  const recs = raRows || [];

  const [trows] = await pool.query('SELECT club_id FROM `terrains` WHERE id = ?', [terrainId]);
  const clubId = (trows && trows[0]) ? trows[0].club_id : null;

  let durationMinutes = slotDurationMinutes;
  if (!durationMinutes) {
    try {
      const [tInfoRows] = await pool.query('SELECT slot_duration FROM `terrains` WHERE id = ?', [terrainId]);
      if (tInfoRows && tInfoRows[0] && tInfoRows[0].slot_duration) {
        durationMinutes = Number(tInfoRows[0].slot_duration) || 60;
      } else {
        durationMinutes = 60;
      }
    } catch (e) {
      durationMinutes = 60;
    }
  }

  const [exRows] = await pool.query("SELECT id, DATE_FORMAT(date, '%Y-%m-%d') AS date_str, is_closed, special_open_time, special_close_time FROM availability_exceptions WHERE terrain_id = ?", [terrainId]);
  const exs = (exRows || []).reduce((acc,e)=>{ acc[e.date_str]=e; return acc; }, {});

  const slotsToInsert = [];
  const dayMs = 24*60*60*1000;
  const [existingRows] = await pool.query("SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date_str, start_time, end_time FROM slots WHERE terrain_id = ? AND DATE(date) BETWEEN ? AND ?", [terrainId, fromDate, toDate]);
  // build map date => [{sMin, eMin}, ...]
  const existingByDate = {};
  (existingRows || []).forEach(r => {
    const key = r.date_str || String(r.date);
    const sMin = timeToMinutes(r.start_time);
    const eMin = timeToMinutes(r.end_time);
    existingByDate[key] = existingByDate[key] || [];
    existingByDate[key].push({ sMin, eMin });
  });
  // iterate days using explicit UTC midnight to avoid local timezone parsing differences
  const startDate = new Date(fromDate + 'T00:00:00Z');
  const endDate = new Date(toDate + 'T00:00:00Z');
  for(let d = new Date(startDate); d.getTime() <= endDate.getTime(); d = new Date(d.getTime()+dayMs)){
    const isoDate = d.toISOString().slice(0,10);
    const exception = exs[isoDate];

    if(exception && exception.is_closed){
      continue; // closed whole day
    }

    // Find recurring that match this day of week
    const dow = d.getDay(); // 0=Sun ... 6=Sat (assume DB uses same)
    for(const r of recs){
      if(r.is_closed) continue;
      if(Number(r.day_of_week) !== dow) continue;

      // determine start/end, possibly overridden by exception special times
      const start = (exception && exception.special_open_time) ? exception.special_open_time : r.start_time;
      const end = (exception && exception.special_close_time) ? exception.special_close_time : r.end_time;

      let cur = timeToMinutes(start);
      const endM = timeToMinutes(end);
      while(cur + durationMinutes <= endM){
        const sh = String(Math.floor(cur/60)).padStart(2,'0') + ':' + String(cur%60).padStart(2,'0');
        const ehMin = cur + durationMinutes;
        const eh = String(Math.floor(ehMin/60)).padStart(2,'0') + ':' + String(ehMin%60).padStart(2,'0');

        // Check overlap with existing slots on the same date
        const existing = existingByDate[isoDate] || [];
        const newS = cur;
        const newE = ehMin;
        let overlaps = false;
        for (const ex of existing) {
          // overlap if ex.sMin < newE && ex.eMin > newS
          if (ex.sMin < newE && ex.eMin > newS) { overlaps = true; break; }
        }
        if (!overlaps) {
          // include clubId so slots can be queried by club without join
          slotsToInsert.push([terrainId, clubId, isoDate, sh, eh, 'free']);
        }
        cur += durationMinutes;
      }
    }
  }

  if(slotsToInsert.length===0) return { inserted: 0 };

  // Ensure we have a clubId value (re-fetch in case terrains changed)
  try{
    if (clubId == null) {
      const [trows2] = await pool.query('SELECT club_id FROM `terrains` WHERE id = ?', [terrainId]);
      clubId = (trows2 && trows2[0]) ? trows2[0].club_id : clubId;
    }
  } catch(e) {
    // ignore — we'll fallback below
  }

  // If still null, use fallback 0 to avoid inserting NULLs (mock data scenario)
  if (clubId == null) {
    console.warn(`generateSlotsForTerrain: terrain ${terrainId} has no club_id, inserting 0 as fallback`);
    clubId = 0;
    // Also patch each slotsToInsert to ensure clubId column is set (in case any were built earlier)
    for (let i = 0; i < slotsToInsert.length; i++) {
      const row = slotsToInsert[i];
      // row format: [terrainId, clubId, date, start, end, status]
      row[1] = clubId;
    }
  }

  const valuesSql = slotsToInsert.map(()=> '(?, ?, ?, ?, ?, ?)').join(', ');
  const flat = slotsToInsert.flat();
  const sql = `INSERT IGNORE INTO slots (terrain_id, club_id, date, start_time, end_time, status) VALUES ${valuesSql}`;
  try {
    const [result] = await pool.query(sql, flat);
    const inserted = (result && (result.affectedRows || result.affected_rows)) ? (result.affectedRows || result.affected_rows) : 0;
    return { inserted };
  } catch (err) {
    console.error('Error inserting slots:', err && err.message ? err.message : err);
    return { inserted: 0, error: err && err.message };
  }
}

async function adminGenerateSlots(req, res){
  // Scope to caller's club. Never generate for terrains outside their club.
  const adminClubId = req.user && req.user.club_id;
  if (!adminClubId) return res.status(403).json({ error: 'club admin scope required' });

  const daysRaw = Object.prototype.hasOwnProperty.call(req.body, 'days') ? req.body.days : undefined;
  const weeksRaw = Object.prototype.hasOwnProperty.call(req.body, 'weeks') ? req.body.weeks : undefined;
  const days = typeof daysRaw !== 'undefined' ? Number(daysRaw) : null;
  const weeks = typeof weeksRaw !== 'undefined' ? Number(weeksRaw) : null;
  const fromDate = req.body.fromDate || new Date().toISOString().slice(0,10);
  let toDate;
  if (req.body.toDate) {
    toDate = req.body.toDate;
  } else if (days !== null) {
    toDate = new Date(new Date(fromDate).getTime() + days*24*60*60*1000).toISOString().slice(0,10);
  } else if (weeks !== null) {
    toDate = new Date(new Date(fromDate).getTime() + (weeks*7*24*60*60*1000)).toISOString().slice(0,10);
  } else {
    toDate = new Date(new Date(fromDate).getTime() + (6*7*24*60*60*1000)).toISOString().slice(0,10);
  }

  const [tRows] = await pool.query('SELECT id FROM `terrains` WHERE club_id = ?', [adminClubId]);
  const terrains = tRows || [];
  let totalInserted = 0;
  for(const t of terrains){
    const r = await generateSlotsForTerrain(t.id, fromDate, toDate);
    totalInserted += r.inserted || 0;
  }

  res.json({ ok: true, fromDate, toDate, totalInserted });
}

async function adminGenerateSlotsForTerrain(req, res){
  const terrainId = Number(req.body.terrain_id);
  if(!Number.isFinite(terrainId)) return res.status(400).json({ error: 'terrain_id required' });
  // ownership: terrain must belong to caller's club
  const [trows] = await pool.query('SELECT club_id FROM terrains WHERE id = ?', [terrainId]);
  if (!trows || !trows[0]) return res.status(404).json({ error: 'terrain not found' });
  if (Number(trows[0].club_id) !== Number(req.user.club_id)) return res.status(403).json({ error: 'forbidden' });
  const weeksRaw = Object.prototype.hasOwnProperty.call(req.body, 'weeks') ? req.body.weeks : undefined;
  const weeks = typeof weeksRaw !== 'undefined' ? Number(weeksRaw) : null;
  const fromDate = req.body.fromDate || new Date().toISOString().slice(0,10);
  let toDate = req.body.toDate;
  if (typeof toDate === 'undefined' || toDate === null) {
    if (weeks !== null) {
      toDate = new Date(new Date(fromDate).getTime() + (weeks*7*24*60*60*1000)).toISOString().slice(0,10);
    } else {
      toDate = new Date(new Date(fromDate).getTime() + (6*7*24*60*60*1000)).toISOString().slice(0,10);
    }
  }
  const r = await generateSlotsForTerrain(terrainId, fromDate, toDate);
  res.json({ ok:true, terrainId, fromDate, toDate, inserted: r.inserted });
}

async function adminGenerateSlotsForClub(req, res){
  const clubId = Number(req.body.club_id);
  if(!Number.isFinite(clubId)) return res.status(400).json({ error: 'club_id required' });
  if (Number(req.user.club_id) !== clubId) return res.status(403).json({ error: 'forbidden' });
  const weeksRaw = Object.prototype.hasOwnProperty.call(req.body, 'weeks') ? req.body.weeks : undefined;
  const weeks = typeof weeksRaw !== 'undefined' ? Number(weeksRaw) : null;
  const fromDate = req.body.fromDate || new Date().toISOString().slice(0,10);
  let toDate = req.body.toDate;
  if (typeof toDate === 'undefined' || toDate === null) {
    if (weeks !== null) {
      toDate = new Date(new Date(fromDate).getTime() + (weeks*7*24*60*60*1000)).toISOString().slice(0,10);
    } else {
      toDate = new Date(new Date(fromDate).getTime() + (6*7*24*60*60*1000)).toISOString().slice(0,10);
    }
  }

  const [terrRows] = await pool.query('SELECT id FROM `terrains` WHERE club_id = ?', [clubId]);
  const terrains = terrRows || [];
  let totalInserted = 0;
  for(const t of terrains){
    const r = await generateSlotsForTerrain(t.id, fromDate, toDate);
    totalInserted += r.inserted || 0;
  }

  res.json({ ok:true, clubId, fromDate, toDate, totalInserted, terrains: terrains.map(t=>t.id) });
}

async function listSlots(req, res){
  const terrainId = req.params.id;
  const date = req.query.date; // optional
  const status = req.query.status; // optional
  const params = [terrainId];
  let sql = 'SELECT * FROM slots WHERE terrain_id = ?';
  
  // TOUJOURS filtrer pour ne retourner que les dates futures ou aujourd'hui
  sql += ' AND date >= CURDATE()';
  
  if(date){ sql += ' AND date = ?'; params.push(date); }
  if(status){ sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY date, start_time';
  const [rows] = await pool.query(sql, params);
  res.json(rows || []);
}

async function listSlotsByClub(req, res){
  const clubId = req.params.id;
  const date = req.query.date; // optional
  const status = req.query.status; // optional - par défaut 'free' si non spécifié
  const params = [clubId];
  let sql = 'SELECT * FROM slots WHERE club_id = ?';
  
  // TOUJOURS filtrer pour ne retourner que les dates futures ou aujourd'hui
  sql += ' AND date >= CURDATE()';
  
  if(date){ sql += ' AND date = ?'; params.push(date); }
  
  // Si status n'est pas spécifié, retourner seulement les slots 'free' par défaut
  if(status){
    sql += ' AND status = ?';
    params.push(status);
  } else {
    // Par défaut, ne retourner que les slots disponibles
    sql += ' AND status = ?';
    params.push('free');
  }
  
  sql += ' ORDER BY date, start_time';
  console.log('🔍 [listSlotsByClub] SQL:', sql);
  console.log('🔍 [listSlotsByClub] Params:', params);
  const [rows] = await pool.query(sql, params);
  console.log(`✅ [listSlotsByClub] ${rows.length} slots retournés`);
  if (rows.length > 0) {
    console.log('📅 Première date:', rows[0].date);
    console.log('📅 Dernière date:', rows[rows.length - 1].date);
  }
  res.json(rows || []);
}

async function bookSlot(req, res){
  const slotId = req.params.id;
  // SECURITY: never trust user_id from request body. Always use authenticated user.
  const userId = req.user && req.user.id;
  if(!userId) return res.status(401).json({ ok:false, error: 'authentication required' });
  const conn = await db.getConnection && await db.getConnection();
  try{
    if(conn){
      await conn.beginTransaction();
  const [srows] = await conn.query('SELECT status, date, start_time, end_time, terrain_id FROM slots WHERE id = ? FOR UPDATE', [slotId]);
  const row = srows && srows[0];
      if(!row) throw new Error('slot not found');
      if(row.status !== 'free') throw new Error('slot not available');

  const [cols] = await conn.query('SHOW COLUMNS FROM reservations');
  const colNames = (cols || []).map(c => c.Field);
  const colTypeMap = (cols || []).reduce((m, c) => { m[c.Field] = c.Type; return m; }, {});
  const insertCols = [];
  const insertVals = [];

  if (colNames.includes('user_id')) { insertCols.push('user_id'); insertVals.push(userId); }
  if (colNames.includes('status')) { insertCols.push('status'); insertVals.push('confirmed'); }
  if (colNames.includes('date')) {
    let dateVal = formatDatePart(row.date) || row.date;
    const t = (colTypeMap['date'] || '').toLowerCase();
    if (t.includes('datetime') || t.includes('timestamp')) {
      const dpart = formatDatePart(row.date) || '';
      dateVal = dpart + ' ' + (row.start_time || '00:00:00');
    }
    insertCols.push('date'); insertVals.push(dateVal);
  }
  if (colNames.includes('start_time')) {
    let stVal = row.start_time;
    const t = (colTypeMap['start_time'] || '').toLowerCase();
    if ((t.includes('datetime') || t.includes('timestamp')) && row.date) {
      const dpart = formatDatePart(row.date) || '';
      stVal = dpart + ' ' + (row.start_time || '00:00:00');
    }
    insertCols.push('start_time'); insertVals.push(stVal);
  }
  if (colNames.includes('end_time')) {
    let enVal = row.end_time;
    const t = (colTypeMap['end_time'] || '').toLowerCase();
    if ((t.includes('datetime') || t.includes('timestamp')) && row.date) {
      const dpart = formatDatePart(row.date) || '';
      enVal = dpart + ' ' + (row.end_time || '00:00:00');
    }
    insertCols.push('end_time'); insertVals.push(enVal);
  }
      let reservationId = null; // Initialize reservationId

      // prefer price from request body (front) to avoid mismatch; fallback to computedPrice
      let computedPrice = null;
      try {
        // if front sent a price, use it
        if (req.body && typeof req.body.price !== 'undefined' && req.body.price !== null) {
          computedPrice = Math.round(Number(req.body.price || 0) * 100) / 100;
        } else {
          const [tinfoRows] = await conn.query('SELECT price_per_hour, price, slot_price FROM `terrains` WHERE id = ?', [row.terrain_id]);
          const tinfo = (tinfoRows && tinfoRows[0]) ? tinfoRows[0] : null;
          const pph = tinfo ? (tinfo.price_per_hour ?? tinfo.price ?? tinfo.slot_price ?? 0) : 0;
          computedPrice = Math.round(Number(pph || 0) * 100) / 100;
        }
      } catch (e) {
        computedPrice = Math.round(Number(req.body && req.body.price || 0) * 100) / 100;
      }
      if (colNames.includes('price')) { insertCols.push('price'); insertVals.push(computedPrice); }
        // perform insert for reservation now that insertCols/insertVals are ready
        if (insertCols.length === 0) throw new Error('No insertable columns found for reservations');
        const placeholders = insertCols.map(()=>'?').join(', ');
    const sqlInsert = `INSERT INTO reservations (${insertCols.join(',')}) VALUES (${placeholders})`;
    // debug log: show what we insert for reservations
    try { console.log('reservations INSERT (tx): cols=', insertCols, 'vals=', insertVals); } catch(e){}
    const [rres] = await conn.query(sqlInsert, insertVals);
        reservationId = (rres && (rres.insertId || rres.insert_id)) ? (rres.insertId || rres.insert_id) : null;
        if(!reservationId) throw new Error('cannot create reservation');

        await conn.query('UPDATE slots SET status = ?, reservation_id = ? WHERE id = ?', ['booked', reservationId, slotId]);
        await conn.commit();
        res.json({ ok: true, reservationId });
    } else {
  const [srows] = await pool.query('SELECT status, date, start_time, end_time, terrain_id FROM slots WHERE id = ?', [slotId]);
  const row = srows && srows[0];
      if(!row) throw new Error('slot not found');
      if(row.status !== 'free') throw new Error('slot not available');

  const slotDate = row.date;
  const slotStart = row.start_time;
  const slotEnd = row.end_time;
  const terrainId = row.terrain_id;

  const [cols2] = await pool.query('SHOW COLUMNS FROM reservations');
  const colNames2 = (cols2 || []).map(c => c.Field);
  const colTypeMap2 = (cols2 || []).reduce((m, c) => { m[c.Field] = c.Type; return m; }, {});
  const insertCols2 = [];
  const insertVals2 = [];
  if (colNames2.includes('user_id')) { insertCols2.push('user_id'); insertVals2.push(userId); }
  if (colNames2.includes('status')) { insertCols2.push('status'); insertVals2.push('confirmed'); }
  if (colNames2.includes('date')) {
    let dval = formatDatePart(slotDate) || slotDate;
    const t = (colTypeMap2['date'] || '').toLowerCase();
    if (t.includes('datetime') || t.includes('timestamp')) dval = (formatDatePart(slotDate) || '') + ' ' + (slotStart || '00:00:00');
    insertCols2.push('date'); insertVals2.push(dval);
  }
  if (colNames2.includes('start_time')) {
    let sVal = slotStart;
    const t = (colTypeMap2['start_time'] || '').toLowerCase();
    if (t.includes('datetime') || t.includes('timestamp')) sVal = (formatDatePart(slotDate) || '') + ' ' + (slotStart || '00:00:00');
    insertCols2.push('start_time'); insertVals2.push(sVal);
  }
  if (colNames2.includes('end_time')) {
    let eVal = slotEnd;
    const t = (colTypeMap2['end_time'] || '').toLowerCase();
    if (t.includes('datetime') || t.includes('timestamp')) eVal = (formatDatePart(slotDate) || '') + ' ' + (slotEnd || '00:00:00');
    insertCols2.push('end_time'); insertVals2.push(eVal);
  }
  if (colNames2.includes('terrain_id')) { insertCols2.push('terrain_id'); insertVals2.push(terrainId); }
  if (colNames2.includes('created_at')) { insertCols2.push('created_at'); insertVals2.push(new Date().toISOString().slice(0,19).replace('T',' ')); }
  // prefer price from request body, else compute from terrain
  let computedPrice2 = null;
  try {
    if (req.body && typeof req.body.price !== 'undefined' && req.body.price !== null) {
      computedPrice2 = Math.round(Number(req.body.price || 0) * 100) / 100;
    } else {
      const [tinfoRows2] = await pool.query('SELECT price_per_hour, price, slot_price FROM `terrains` WHERE id = ?', [terrainId]);
      const tinfo2 = (tinfoRows2 && tinfoRows2[0]) ? tinfoRows2[0] : null;
      const pph2 = tinfo2 ? (tinfo2.price_per_hour ?? tinfo2.price ?? tinfo2.slot_price ?? 0) : 0;
      computedPrice2 = Math.round(Number(pph2 || 0) * 100) / 100;
    }
  } catch (e) {
    computedPrice2 = Math.round(Number(req.body && req.body.price || 0) * 100) / 100;
  }
  if (colNames2.includes('price')) { insertCols2.push('price'); insertVals2.push(computedPrice2); }
  if (insertCols2.length === 0) throw new Error('No insertable columns found for reservations');
  const placeholders2 = insertCols2.map(()=>'?').join(', ');
  const sql2 = `INSERT INTO reservations (${insertCols2.join(',')}) VALUES (${placeholders2})`;
  // debug log: show what we insert for reservations (non-tx)
  try { console.log('reservations INSERT: cols=', insertCols2, 'vals=', insertVals2); } catch(e){}
  const [rres] = await pool.query(sql2, insertVals2);
  const reservationId = (rres && (rres.insertId || rres.insert_id)) ? (rres.insertId || rres.insert_id) : null;
  if(!reservationId) throw new Error('cannot create reservation');

      await pool.query('UPDATE slots SET status = ?, reservation_id = ? WHERE id = ?', ['booked', reservationId, slotId]);
      res.json({ ok: true, reservationId });
    }
  }catch(err){
    if(conn) await conn.rollback();
    res.status(400).json({ ok:false, error: err.message });
  }finally{
    if(conn && conn.release) conn.release();
  }
}

// POST /reservations/:id/cancel
async function cancelReservation(req, res){
  const reservationId = Number(req.params.id);
  if (!Number.isFinite(reservationId)) return res.status(400).json({ ok:false, error:'id invalide' });
  const userId = req.user && req.user.id;
  if(!userId) return res.status(401).json({ ok:false, error:'authentication required' });

  const [rrows] = await pool.query('SELECT id, slot_id, status, user_id, terrain_id FROM reservations WHERE id = ?', [reservationId]);
  const row = rrows && rrows[0];
  if(!row) return res.status(404).json({ ok:false, error:'reservation not found' });

  // Only the reservation owner OR the club admin of the terrain's club may cancel.
  const isOwner = Number(row.user_id) === Number(userId);
  let isClubAdmin = false;
  if (req.user.role === 'club_admin' && req.user.club_id) {
    const [trows] = await pool.query('SELECT club_id FROM terrains WHERE id = ?', [row.terrain_id]);
    isClubAdmin = trows && trows[0] && Number(trows[0].club_id) === Number(req.user.club_id);
  }
  if (!isOwner && !isClubAdmin) return res.status(403).json({ ok:false, error:'forbidden' });

  if(row.status !== 'active' && row.status !== 'confirmed') return res.status(400).json({ ok:false, error:'cannot cancel' });

  await pool.query('UPDATE reservations SET status = ? WHERE id = ?', ['cancelled', reservationId]);
  if (row.slot_id) {
    await pool.query('UPDATE slots SET status = ? WHERE id = ?', ['free', row.slot_id]);
  } else {
    await pool.query('UPDATE slots SET status = ?, reservation_id = NULL WHERE reservation_id = ?', ['free', reservationId]);
  }
  res.json({ ok:true });
}

// DELETE /admin/slots/cleanup — scoped to caller's club only.
async function adminCleanupSlots(req, res){
  const adminClubId = req.user && req.user.club_id;
  if (!adminClubId) return res.status(403).json({ error: 'club admin scope required' });
  const keepDays = Number(req.body.keepDays || 30);
  if (!Number.isFinite(keepDays) || keepDays < 1 || keepDays > 3650) {
    return res.status(400).json({ error: 'keepDays invalide (1-3650)' });
  }
  const cutoff = new Date(Date.now() - keepDays*24*60*60*1000).toISOString().slice(0,10);
  await pool.query('DELETE FROM slots WHERE date < ? AND club_id = ?', [cutoff, adminClubId]);
  res.json({ ok:true, cutoff });
}

// GET /terrains/:id/slots - List slots for a terrain with terrain details
async function listSlots(req, res){
  try {
    const terrainId = req.params.id;
    const { date } = req.query;
    
    let sql = `
      SELECT s.*, t.name as terrain_name, t.sport_type, t.club_id
      FROM slots s
      JOIN terrains t ON s.terrain_id = t.id
      WHERE s.terrain_id = ?
    `;
    const params = [terrainId];
    
    if (date) {
      sql += ' AND DATE(s.date) = ?';
      params.push(date);
    }
    
    sql += ' ORDER BY s.date, s.start_time';
    
    const [slots] = await pool.query(sql, params);
    res.json(slots || []);
  } catch (error) {
    console.error('Error listing slots:', error);
    res.status(500).json({ error: 'Error fetching slots' });
  }
}

// GET /clubs/:id/slots - List slots for all terrains of a club with terrain details
async function listSlotsByClub(req, res){
  try {
    const clubId = req.params.id;
    const { date } = req.query;
    
    let sql = `
      SELECT s.*, t.name as terrain_name, t.sport_type, t.club_id
      FROM slots s
      JOIN terrains t ON s.terrain_id = t.id
      WHERE t.club_id = ?
    `;
    const params = [clubId];
    
    if (date) {
      sql += ' AND DATE(s.date) = ?';
      params.push(date);
    }
    
    sql += ' ORDER BY s.date, s.start_time, t.name';
    
    const [slots] = await pool.query(sql, params);
    res.json(slots || []);
  } catch (error) {
    console.error('Error listing club slots:', error);
    res.status(500).json({ error: 'Error fetching club slots' });
  }
}

// Admin: remove duplicate slots within caller's club only.
async function adminRemoveDuplicateSlots(req, res){
  const adminClubId = req.user && req.user.club_id;
  if (!adminClubId) return res.status(403).json({ error: 'club admin scope required' });
  const sql = `
    DELETE s1 FROM slots s1
    INNER JOIN slots s2
      ON s1.terrain_id = s2.terrain_id
      AND s1.date = s2.date
      AND s1.start_time = s2.start_time
      AND s1.id > s2.id
    WHERE s1.club_id = ?
  `;
  const [result] = await pool.query(sql, [adminClubId]);
  const deleted = result?.affectedRows ?? 0;
  res.json({ ok:true, deleted });
}

// Admin: wipe slots of caller's club only — never the entire table.
async function adminTruncateSlots(req, res){
  const adminClubId = req.user && req.user.club_id;
  if (!adminClubId) return res.status(403).json({ error: 'club admin scope required' });
  const [result] = await pool.query('DELETE FROM slots WHERE club_id = ?', [adminClubId]);
  res.json({ ok:true, deleted: result?.affectedRows ?? 0 });
}

  return {
    adminGenerateSlots,
    adminGenerateSlotsForTerrain,
    adminGenerateSlotsForClub,
    adminRemoveDuplicateSlots,
    adminTruncateSlots,
    listSlots,
    listSlotsByClub,
    bookSlot,
    cancelReservation,
    adminCleanupSlots,
    generateSlotsForTerrain,
  };
};
