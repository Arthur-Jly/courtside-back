const { logger } = require('../utils/logger');
const emailService = require('../services/emailService');
const { notify } = require('../utils/notify');
const { poolOf } = require('../utils/dbHelpers');
const { todayLocalYmd, addDaysYmd, timeToMinutes } = require('../utils/dates');
const config = require('../config');

const HHMM = /^\d{2}:\d{2}$/;
// Stripe refuse une valeur de metadata > 500 caractères.
const STRIPE_METADATA_MAX = 500;

module.exports = function (db) {
  const pool = poolOf(db);

  const stripeKey = process.env.PRIVATE_STRIPE_KEY;
  if (!stripeKey) {
    logger.error('PRIVATE_STRIPE_KEY not set — payments disabled');
  }
  const stripe = stripeKey ? require('stripe')(stripeKey) : null;

  function ensureStripe(res) {
    if (!stripe) {
      res.status(503).json({ error: 'Service de paiement indisponible' });
      return false;
    }
    return true;
  }

  function sanitizeNumber(n, { min = 0, max = 1000000 } = {}) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < min || v > max) return null;
    return v;
  }

  /** Horaires HH:MM du créneau, depuis slotStart/slotEnd ou, à défaut, le libellé « 10:00 - 11:00 ». */
  function resolveSlotTimes({ slotStart, slotEnd, slotLabel, slot }) {
    let start = typeof slotStart === 'string' ? slotStart.slice(0, 5) : null;
    let end = typeof slotEnd === 'string' ? slotEnd.slice(0, 5) : null;
    if (!(start && end)) {
      const label = slotLabel || slot;
      const m = typeof label === 'string' && label.match(/^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/);
      if (m) { start = m[1]; end = m[2]; }
    }
    if (!HHMM.test(start || '') || !HHMM.test(end || '')) return null;
    return { start, end };
  }

  /**
   * Tarif calculé côté serveur : tarif horaire du terrain × durée, arrondi à
   * l'euro comme sur le front, plus les frais de service. Le montant envoyé par
   * le navigateur n'est qu'une vérification, jamais la source du prix.
   */
  function quote(pricePerHour, hours) {
    const subtotal = Math.round(Number(pricePerHour) * hours);
    const total = Math.round((subtotal + config.reservations.serviceFee) * 100) / 100;
    const perPerson = Math.round((total / config.reservations.splitParts) * 100) / 100;
    return { total, perPerson };
  }

  function sanitizePlayers(invitedPlayers) {
    if (!Array.isArray(invitedPlayers)) return [];
    return invitedPlayers.slice(0, 10)
      .map((p) => ({
        firstName: String(p?.firstName || '').slice(0, 30),
        lastName: String(p?.lastName || '').slice(0, 30),
        email: String(p?.email || '').slice(0, 80),
      }))
      .filter((p) => p.firstName || p.email);
  }

  /** Metadata Stripe : tout est dérivé de la base ou borné, jamais recopié tel quel du navigateur. */
  function buildMetadata({ userId, terrain, date, times, slotId, label, prices, splitPayment, invitedPlayers }) {
    const serialize = (players) => JSON.stringify({
      splitPayment: Boolean(splitPayment),
      totalPrice: prices.total,
      pricePerPerson: prices.perPerson,
      invitedPlayers: players,
      court: { name: terrain.name },
    });
    let players = sanitizePlayers(invitedPlayers);
    let reservationData = serialize(players);
    while (reservationData.length > STRIPE_METADATA_MAX && players.length > 0) {
      players = players.slice(0, -1);
      reservationData = serialize(players);
    }
    return {
      reservationData,
      date,
      slot: label,
      userId: String(userId),
      clubId: String(terrain.club_id),
      courtId: String(terrain.id),
      terrainId: String(terrain.id),
      slotStart: times.start,
      slotEnd: times.end,
      ...(slotId != null && { slotId: String(slotId) }),
    };
  }

  async function createCheckoutSession(req, res) {
    if (!ensureStripe(res)) return;
    const { reservationData } = req.body || {};
    if (!reservationData || typeof reservationData !== 'object') {
      return res.status(400).json({ error: 'Données de réservation manquantes' });
    }

    const { court = {}, date, splitPayment, totalPrice, pricePerPerson, invitedPlayers } = reservationData;

    if (!court || typeof court !== 'object') return res.status(400).json({ error: 'Court invalide' });
    if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Date invalide' });
    }
    const today = todayLocalYmd();
    if (date < today) return res.status(400).json({ error: 'Cette date est passée' });
    if (date > addDaysYmd(today, config.reservations.maxAdvanceDays)) {
      return res.status(400).json({ error: 'Cette date est trop lointaine pour être réservée' });
    }

    const times = resolveSlotTimes(reservationData);
    if (!times) return res.status(400).json({ error: 'Horaire invalide' });
    const hours = (timeToMinutes(times.end) - timeToMinutes(times.start)) / 60;
    if (!(hours > 0) || hours > config.reservations.maxDurationHours) {
      return res.status(400).json({ error: 'Durée de réservation invalide' });
    }

    const clientAmount = sanitizeNumber(splitPayment ? pricePerPerson : totalPrice, { min: 0.5, max: 10000 });
    if (clientAmount === null) return res.status(400).json({ error: 'Montant invalide' });

    const terrainId = Number(reservationData.terrainId ?? court.id);
    if (!Number.isInteger(terrainId) || terrainId <= 0) {
      return res.status(400).json({ error: 'Terrain invalide' });
    }
    const [terrainRows] = await pool.query(
      `SELECT t.id, t.club_id, t.name, t.price_per_hour, c.status AS club_status
       FROM terrains t LEFT JOIN clubs c ON c.id = t.club_id
       WHERE t.id = ? LIMIT 1`,
      [terrainId]
    );
    const terrain = terrainRows?.[0];
    if (!terrain) return res.status(404).json({ error: 'Terrain introuvable' });
    if (terrain.club_status !== 'confirme') {
      return res.status(409).json({ error: 'Ce club n\'accepte pas de réservation pour le moment' });
    }

    const prices = quote(terrain.price_per_hour, hours);
    const expectedAmount = splitPayment ? prices.perPerson : prices.total;
    if (Math.abs(clientAmount - expectedAmount) > 0.01) {
      return res.status(400).json({ error: 'Le tarif de ce créneau a changé. Recharge la page et réessaie.' });
    }

    // Refuse before Stripe if the targeted slot is no longer free — the front
    // shows "Ce créneau vient d'être réservé" on 409.
    const slotId = reservationData.slotId != null ? Number(reservationData.slotId) : null;
    if (slotId !== null) {
      if (!Number.isInteger(slotId) || slotId <= 0) return res.status(400).json({ error: 'Créneau invalide' });
      const [slotRows] = await pool.query(
        `SELECT status, terrain_id, DATE_FORMAT(date, '%Y-%m-%d') AS date_str, start_time, end_time
         FROM slots WHERE id = ? LIMIT 1`,
        [slotId]
      );
      const slotRow = slotRows?.[0];
      if (!slotRow) return res.status(404).json({ error: 'Créneau introuvable' });
      if (slotRow.status !== 'free') {
        return res.status(409).json({ error: 'Ce créneau vient d\'être réservé' });
      }
      // Un créneau d'un autre terrain (moins cher) ne doit pas être réservable avec ce tarif.
      if (
        Number(slotRow.terrain_id) !== terrain.id
        || slotRow.date_str !== date
        || String(slotRow.start_time).slice(0, 5) !== times.start
        || String(slotRow.end_time).slice(0, 5) !== times.end
      ) {
        return res.status(400).json({ error: 'Le créneau ne correspond pas à la réservation' });
      }
    } else {
      // Créneau libre : aucun créneau déjà pris ne doit le chevaucher.
      const [busyRows] = await pool.query(
        `SELECT id FROM slots
         WHERE terrain_id = ? AND date = ? AND status <> 'free' AND start_time < ? AND end_time > ?
         LIMIT 1`,
        [terrain.id, date, `${times.end}:00`, `${times.start}:00`]
      );
      if (busyRows?.length > 0) {
        return res.status(409).json({ error: 'Ce créneau vient d\'être réservé' });
      }
    }

    // L'email vient du compte, jamais du corps de la requête.
    const [userRows] = await pool.query('SELECT email FROM users WHERE id = ? LIMIT 1', [req.user.id]);
    const customerEmail = userRows?.[0]?.email || undefined;

    const label = `${times.start} - ${times.end}`;
    const lineItems = [{
      price_data: {
        currency: 'eur',
        product_data: {
          name: `Réservation - ${String(terrain.name).slice(0, 80)}`,
          description: `${date} à ${label}`.slice(0, 200),
        },
        unit_amount: Math.round(expectedAmount * 100),
      },
      quantity: 1,
    }];

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const successUrl = `${baseUrl}/paiement/succes?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseUrl}/paiement/annule`;

    const metadataPayload = buildMetadata({
      userId: req.user.id, terrain, date, times, slotId, label, prices, splitPayment, invitedPlayers,
    });

    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: lineItems,
        mode: 'payment',
        success_url: successUrl,
        cancel_url: cancelUrl,
        customer_email: customerEmail,
        metadata: metadataPayload,
      });
      res.json({ sessionId: session.id, url: session.url });
    } catch (e) {
      logger.error('Stripe session create error: ' + e.message);
      res.status(502).json({ error: 'Erreur lors de la création de la session de paiement' });
    }
  }

  async function handleWebhook(req, res) {
    if (!ensureStripe(res)) return;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      logger.error('STRIPE_WEBHOOK_SECRET not set — rejecting webhook');
      return res.status(503).send('Webhook not configured');
    }
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch {
      logger.warn('Webhook signature verification failed');
      return res.status(400).send('Invalid signature');
    }

    try {
      if (event.type === 'checkout.session.completed') {
        await handleSuccessfulPayment(event.data.object);
      } else if (event.type === 'payment_intent.payment_failed') {
        logger.warn(`Payment failed: ${event.data.object.id}`);
      }
    } catch (e) {
      // 500 : Stripe rejoue l'événement (le traitement est idempotent sur stripe_session_id).
      // Répondre 200 ici perdait définitivement une réservation déjà payée.
      logger.error('Webhook handler error: ' + e.message);
      return res.status(500).json({ error: 'Webhook handler failed' });
    }
    res.json({ received: true });
  }

  async function handleSuccessfulPayment(session) {
    if (session.payment_status !== 'paid') {
      logger.warn(`Session ${session.id} not paid (status=${session.payment_status})`);
      return;
    }
    try {
      // Share payments (a teammate paying their part of a split
      // reservation) record the payment and never create a reservation.
      const shareForReservation = Number(session.metadata?.share_for_reservation);
      if (Number.isFinite(shareForReservation) && shareForReservation > 0) {
        await pool.query(`
          INSERT IGNORE INTO reservation_share_payments
            (reservation_id, stripe_session_id, amount, payer_email, created_at)
          VALUES (?, ?, ?, ?, NOW())
        `, [
          shareForReservation,
          session.id,
          session.amount_total != null ? session.amount_total / 100 : 0,
          session.customer_email || session.customer_details?.email || null,
        ]);
        logger.info(`Share payment recorded for reservation ${shareForReservation}`);
        return;
      }
      // Idempotence: the webhook and the confirm-payment fallback can both fire
      // for the same Checkout session — only the first one may create the reservation.
      const [existing] = await pool.query(
        'SELECT id FROM reservations WHERE stripe_session_id = ? LIMIT 1',
        [session.id]
      );
      if (existing?.length > 0) {
        logger.info(`Session ${session.id} already processed (reservation ${existing[0].id})`);
        return;
      }

      const metadata = session.metadata || {};
      const reservationData = metadata.reservationData ? JSON.parse(metadata.reservationData) : {};
      const slotIdFromMetadata = metadata.slotId ? Number(metadata.slotId) : reservationData.slotId;
      const terrainIdFromMeta = metadata.terrainId ? Number(metadata.terrainId) : reservationData.terrainId;

      const {
        invitedPlayers = [], court = {}, date,
        slot, slotStart, slotEnd, totalPrice = 0, splitPayment, pricePerPerson,
      } = reservationData;
      const bookedDate = date || metadata.date;
      const slotStartValue = slotStart || metadata.slotStart;
      const slotEndValue = slotEnd || metadata.slotEnd || slotStartValue;
      const clubIdForTerrain = metadata.clubId || court.club_id || court.clubId;

      let terrains = [];
      if (clubIdForTerrain && court.name) {
        const [rows] = await pool.query(
          'SELECT id FROM terrains WHERE club_id = ? AND name = ? LIMIT 1',
          [clubIdForTerrain, court.name]
        );
        terrains = rows;
      }

      let terrainId = terrainIdFromMeta;
      if (!terrainId && terrains?.length > 0) terrainId = terrains[0].id;
      if (!terrainId && court.id) terrainId = court.id;
      if (!terrainId) {
        logger.error('handleSuccessfulPayment: terrain not found');
        return;
      }

      // ONLY tie a reservation to a userId that came from the authenticated session creator.
      const userIdFromMeta = Number(metadata.userId);
      let userId = Number.isFinite(userIdFromMeta) && userIdFromMeta > 0 ? userIdFromMeta : null;

      if (!userId && session.customer_email) {
        // Fallback: match existing user by email — never create one.
        const [users] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [session.customer_email]);
        if (users?.length > 0) userId = users[0].id;
      }
      if (!userId) {
        logger.error('handleSuccessfulPayment: no userId resolvable — aborting');
        return;
      }

      const slotLabel = slot || metadata.slot || '';
      const [startTimeRaw, endTimeRaw] = slotLabel.includes('-')
        ? slotLabel.split(' - ')
        : [slotStartValue, slotEndValue];

      const normalizeTime = (timeStr) => {
        if (!timeStr) return null;
        const t = String(timeStr).trim();
        if (/^\d{2}:\d{2}:\d{2}$/.test(t)) return t;
        if (/^\d{2}:\d{2}$/.test(t)) return `${t}:00`;
        const d = new Date(`1970-01-01T${t}`);
        if (!isNaN(d.getTime())) return d.toISOString().substring(11, 19);
        return null;
      };

      const normalizedStart = normalizeTime(startTimeRaw);
      const normalizedEnd = normalizeTime(endTimeRaw);
      if (!normalizedStart || !normalizedEnd) {
        logger.error('handleSuccessfulPayment: invalid times');
        return;
      }
      const startDateTime = `${bookedDate} ${normalizedStart}`;
      const endDateTime = `${bookedDate} ${normalizedEnd}`;

      // Split into N players by default (matches the frontend price per person).
      const splitTotal = splitPayment ? config.reservations.splitParts : null;
      const [reservationResult] = await pool.query(
        'INSERT INTO reservations (user_id, terrain_id, start_time, end_time, price, status, stripe_session_id, split_total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())',
        [userId, terrainId, startDateTime, endDateTime, splitPayment ? pricePerPerson : totalPrice, 'confirmed', session.id, splitTotal]
      );
      const reservationId = reservationResult.insertId;

      // Confirmation email + in-app notification (both fire-and-forget).
      const confirmationEmail = session.customer_email || session.customer_details?.email;
      if (confirmationEmail) {
        emailService.sendReservationConfirmed(confirmationEmail, {
          courtName: court.name,
          date: bookedDate,
          slot: metadata.slot || `${normalizedStart.slice(0, 5)} - ${normalizedEnd.slice(0, 5)}`,
          amount: session.amount_total != null ? session.amount_total / 100 : undefined,
        }).catch(e => logger.error('sendReservationConfirmed failed: ' + e.message));
      }
      notify(db, userId, 'reservation_confirmed', {
        reservation_id: reservationId,
        court_name: court.name || '',
        date: bookedDate,
        slot: metadata.slot || '',
      });

      const updateSlotById = async (slotId) => {
        if (!slotId) return 0;
        const [r] = await pool.query(
          'UPDATE slots SET status = ?, reservation_id = ?, updated_at = NOW() WHERE id = ? AND status = ?',
          ['booked', reservationId, slotId, 'free']
        );
        return r.affectedRows || 0;
      };

      let updatedRows = 0;
      if (slotIdFromMetadata) updatedRows = await updateSlotById(slotIdFromMetadata);

      if (updatedRows === 0) {
        const [slots] = await pool.query(
          'SELECT id FROM slots WHERE terrain_id = ? AND date = ? AND start_time = ? AND end_time = ? AND status = ? LIMIT 1',
          [terrainIdFromMeta || terrainId, bookedDate, normalizedStart, normalizedEnd, 'free']
        );
        if (slots?.length > 0) {
          await pool.query(
            'UPDATE slots SET status = ?, reservation_id = ? WHERE id = ?',
            ['booked', reservationId, slots[0].id]
          );
        } else {
          try {
            await pool.query(
              'INSERT INTO slots (terrain_id, club_id, date, start_time, end_time, status, reservation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
              [terrainId, metadata.clubId || null, bookedDate, normalizedStart, normalizedEnd, 'booked', reservationId]
            );
          } catch (slotErr) {
            // Le créneau a été pris entre la création de la session et le paiement :
            // le client a payé, il faut un remboursement manuel (ou automatique à terme).
            if (slotErr.code === 'ER_DUP_ENTRY') {
              logger.error(`PAIEMENT À REMBOURSER: session ${session.id} réservation ${reservationId} — créneau déjà pris (double réservation)`);
            }
            throw slotErr;
          }
        }
      }

      if (Array.isArray(invitedPlayers) && invitedPlayers.length > 0) {
        for (const player of invitedPlayers.slice(0, 50)) {
          if (player?.email || player?.firstName) {
            await pool.query(
              'INSERT INTO reservation_participants (reservation_id, name, email, created_at) VALUES (?, ?, ?, NOW())',
              [
                reservationId,
                `${String(player.firstName || '').slice(0, 50)} ${String(player.lastName || '').slice(0, 50)}`.trim(),
                String(player.email || '').slice(0, 254),
              ]
            );
          }
        }
      }
    } catch (e) {
      logger.error('handleSuccessfulPayment error: ' + e.message);
      throw e;
    }
  }

  async function getSessionDetails(req, res) {
    if (!ensureStripe(res)) return;
    try {
      const { sessionId } = req.params;
      if (!sessionId || !/^cs_[a-zA-Z0-9_]{10,}$/.test(sessionId)) {
        return res.status(400).json({ error: 'Session ID invalide' });
      }
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      // Only the user who created the session may see its details.
      if (session.metadata?.userId && Number(session.metadata.userId) !== Number(req.user?.id)) {
        return res.status(403).json({ error: 'Accès refusé' });
      }
      res.json({
        id: session.id,
        status: session.payment_status,
        customerEmail: session.customer_email,
        amountTotal: session.amount_total / 100,
        metadata: session.metadata,
      });
    } catch (e) {
      logger.error('getSessionDetails error: ' + e.message);
      res.status(502).json({ error: 'Erreur lors de la récupération de la session' });
    }
  }

  async function confirmPayment(req, res) {
    if (!ensureStripe(res)) return;
    const { sessionId } = req.body || {};
    if (!sessionId || !/^cs_[a-zA-Z0-9_]{10,}$/.test(sessionId)) {
      return res.status(400).json({ error: 'Session ID invalide' });
    }
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status !== 'paid') {
        return res.status(400).json({ error: 'Paiement non confirmé', status: session.payment_status });
      }
      // Only the original creator (authenticated) can trigger the fallback create-on-success.
      if (session.metadata?.userId && req.user?.id && Number(session.metadata.userId) !== Number(req.user.id)) {
        return res.status(403).json({ error: 'Accès refusé' });
      }
      await handleSuccessfulPayment(session);
      res.json({ success: true, message: 'Paiement confirmé' });
    } catch (e) {
      logger.error('confirmPayment error: ' + e.message);
      res.status(502).json({ error: 'Erreur lors de la confirmation du paiement' });
    }
  }

  /**
   * Split fare: the organizer generates a payment link for one teammate's
   * share of an already-paid reservation. The link is a plain Stripe
   * Checkout URL — shareable in any chat, no account required to pay.
   */
  async function createShareLink(req, res) {
    if (!ensureStripe(res)) return;
    const { checkout_session_id } = req.body || {};
    if (!checkout_session_id || !/^cs_[a-zA-Z0-9_]{10,}$/.test(checkout_session_id)) {
      return res.status(400).json({ error: 'Session ID invalide' });
    }
    try {
      const [rows] = await pool.query(
        'SELECT id, user_id, price FROM reservations WHERE stripe_session_id = ? LIMIT 1',
        [checkout_session_id]
      );
      const reservation = rows?.[0];
      if (!reservation) return res.status(404).json({ error: 'Réservation introuvable' });
      if (Number(reservation.user_id) !== Number(req.user?.id)) {
        return res.status(403).json({ error: 'Accès refusé' });
      }
      const amount = sanitizeNumber(reservation.price, { min: 0.5, max: 10000 });
      if (amount === null) return res.status(400).json({ error: 'Montant de part invalide' });

      const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'eur',
            product_data: {
              name: 'Ta part du terrain — Courtside',
              description: 'Part d\'une réservation partagée',
            },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        }],
        mode: 'payment',
        success_url: `${baseUrl}/paiement/succes?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/paiement/annule`,
        metadata: { share_for_reservation: String(reservation.id) },
      });
      res.json({ url: session.url, amount });
    } catch (e) {
      logger.error('createShareLink error: ' + e.message);
      res.status(502).json({ error: 'Erreur lors de la création du lien de paiement' });
    }
  }

  return { createCheckoutSession, handleWebhook, confirmPayment, getSessionDetails, createShareLink };
};
