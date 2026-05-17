const { logger } = require('../utils/logger');

module.exports = function (db) {
  const pool = (db && typeof db.promise === 'function') ? db.promise() : db;

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

  async function createCheckoutSession(req, res) {
    if (!ensureStripe(res)) return;
    const { reservationData } = req.body || {};
    if (!reservationData || typeof reservationData !== 'object') {
      return res.status(400).json({ error: 'Données de réservation manquantes' });
    }

    const {
      organizer = {}, court = {}, date, slot, slotLabel, slotStart, slotEnd,
      totalPrice, pricePerPerson, splitPayment,
    } = reservationData;

    if (!court || !court.name) return res.status(400).json({ error: 'Court invalide' });
    if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Date invalide' });
    }

    const amount = sanitizeNumber(splitPayment ? pricePerPerson : totalPrice, { min: 0.5, max: 10000 });
    if (amount === null) return res.status(400).json({ error: 'Montant invalide' });

    // Always trust the authenticated user's email — never an arbitrary "organizer.email" from the body.
    const customerEmail = req.user?.email || (typeof organizer.email === 'string' ? organizer.email.slice(0, 254) : undefined);

    const effectiveSlotLabel = slotLabel || slot || (slotStart && slotEnd ? `${slotStart} - ${slotEnd}` : slotStart || 'Horaire non précisé');

    const lineItems = [{
      price_data: {
        currency: 'eur',
        product_data: {
          name: `Réservation - ${String(court.name).slice(0, 80)}`,
          description: `${date} à ${effectiveSlotLabel}`.slice(0, 200),
        },
        unit_amount: Math.round(amount * 100),
      },
      quantity: 1,
    }];

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const successUrl = `${baseUrl}/?payment_session={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseUrl}/?payment=canceled`;

    const metadataPayload = {
      reservationData: JSON.stringify(reservationData).slice(0, 4000),
      date,
      slot: effectiveSlotLabel,
      userId: req.user?.id ? String(req.user.id) : '',
    };
    const clubId = court.club_id ?? court.clubId;
    if (clubId != null) metadataPayload.clubId = String(clubId);
    if (court.id != null) metadataPayload.courtId = String(court.id);
    if (reservationData.slotId != null) metadataPayload.slotId = String(reservationData.slotId);
    if (slotStart) metadataPayload.slotStart = String(slotStart).slice(0, 16);
    if (slotEnd) metadataPayload.slotEnd = String(slotEnd).slice(0, 16);
    const terrainIdMeta = reservationData.terrainId ?? court.id;
    if (terrainIdMeta != null) metadataPayload.terrainId = String(terrainIdMeta);

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
    } catch (err) {
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
      logger.error('Webhook handler error: ' + e.message);
    }
    res.json({ received: true });
  }

  async function handleSuccessfulPayment(session) {
    if (session.payment_status !== 'paid') {
      logger.warn(`Session ${session.id} not paid (status=${session.payment_status})`);
      return;
    }
    try {
      const metadata = session.metadata || {};
      const reservationData = metadata.reservationData ? JSON.parse(metadata.reservationData) : {};
      const slotIdFromMetadata = metadata.slotId ? Number(metadata.slotId) : reservationData.slotId;
      const terrainIdFromMeta = metadata.terrainId ? Number(metadata.terrainId) : reservationData.terrainId;

      const {
        invitedPlayers = [], court = {}, date,
        slot, slotStart, slotEnd, totalPrice = 0, splitPayment, pricePerPerson,
      } = reservationData;
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
      const startDateTime = `${date} ${normalizedStart}`;
      const endDateTime = `${date} ${normalizedEnd}`;

      const [reservationResult] = await pool.query(
        'INSERT INTO reservations (user_id, terrain_id, start_time, end_time, price, status, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
        [userId, terrainId, startDateTime, endDateTime, splitPayment ? pricePerPerson : totalPrice, 'confirmed']
      );
      const reservationId = reservationResult.insertId;

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
          [terrainIdFromMeta || terrainId, date, normalizedStart, normalizedEnd, 'free']
        );
        if (slots?.length > 0) {
          await pool.query(
            'UPDATE slots SET status = ?, reservation_id = ?, updated_at = NOW() WHERE id = ?',
            ['booked', reservationId, slots[0].id]
          );
        } else {
          await pool.query(
            'INSERT INTO slots (terrain_id, club_id, date, start_time, end_time, status, reservation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
            [terrainId, metadata.clubId || null, date, normalizedStart, normalizedEnd, 'booked', reservationId]
          );
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

  return { createCheckoutSession, handleWebhook, confirmPayment, getSessionDetails };
};
