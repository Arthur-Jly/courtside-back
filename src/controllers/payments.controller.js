module.exports = function(db) {
  const pool = (db && typeof db.promise === 'function') ? db.promise() : db;
  
  // Initialiser Stripe avec la clé privée
  const stripe = require('stripe')(process.env.PRIVATE_STRIPE_KEY);

  /**
   * Créer une session de paiement Stripe Checkout
   * POST /api/payments/create-checkout-session
   * Body: {
   *   reservationData: {
   *     organizer: { firstName, lastName, email, phone },
   *     invitedPlayers: [...],
   *     splitPayment: boolean,
   *     court: { ... },
   *     date: string,
   *     slot: string,
   *     totalPrice: number,
   *     pricePerPerson: number
   *   }
   * }
   */
  async function createCheckoutSession(req, res) {
    try {
      const { reservationData } = req.body;
      
      if (!reservationData) {
        return res.status(400).json({ error: 'Données de réservation manquantes' });
      }

      const { organizer, court, date, slot, slotLabel, slotStart, slotEnd, totalPrice, pricePerPerson, splitPayment } = reservationData;
      const effectiveSlotLabel = slotLabel || slot || (slotStart && slotEnd ? `${slotStart} - ${slotEnd}` : slotStart || 'Horaire non précisé');

      // Créer une ligne de produit pour la session Stripe
      const lineItems = [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `Réservation - ${court.name}`,
            description: `${date} à ${effectiveSlotLabel} - ${court.type || court.sport || ''}`.trim(),
            images: court.images && court.images.length > 0 ? [court.images[0]] : [],
          },
          unit_amount: Math.round((splitPayment ? pricePerPerson : totalPrice) * 100), // Stripe utilise les centimes
        },
        quantity: 1,
      }];

      // URLs de succès et d'annulation
      const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const clubId = court.club_id || court.clubId;
      
        // ✅ MODIFIÉ : Rediriger vers la page d'accueil avec le session_id en paramètre pour garder la SPA
        const successUrl = `${baseUrl}/?payment_session={CHECKOUT_SESSION_ID}`;
        const cancelUrl = `${baseUrl}/?payment=canceled`;

      const metadataPayload = {
        reservationData: JSON.stringify(reservationData),
        date,
        slot: effectiveSlotLabel,
      };

      if (clubId ?? court.clubId) {
        metadataPayload.clubId = (clubId ?? court.clubId).toString();
      }
      if (court.id) {
        metadataPayload.courtId = court.id.toString();
      }
      if (reservationData?.slotId) {
        metadataPayload.slotId = reservationData.slotId.toString();
      }
      if (slotStart) {
        metadataPayload.slotStart = slotStart;
      }
      if (slotEnd) {
        metadataPayload.slotEnd = slotEnd;
      }
      const allTerrainId = reservationData?.terrainId || court.id;
      if (allTerrainId) {
        metadataPayload.terrainId = allTerrainId.toString();
      }

      // Créer la session Stripe Checkout
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: lineItems,
        mode: 'payment',
        success_url: successUrl,
        cancel_url: cancelUrl,
        customer_email: organizer.email,
        metadata: metadataPayload,
      });

      res.json({ 
        sessionId: session.id,
        url: session.url 
      });

    } catch (error) {
      console.error('Erreur création session Stripe:', error);
      res.status(500).json({ error: 'Erreur lors de la création de la session de paiement', details: error.message });
    }
  }

  /**
   * Webhook Stripe pour gérer les événements de paiement
   * POST /api/payments/webhook
   */
  async function handleWebhook(req, res) {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error('Erreur webhook signature:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Gérer l'événement
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        await handleSuccessfulPayment(session);
        break;
      case 'payment_intent.payment_failed':
        const paymentIntent = event.data.object;
        console.error('Payment failed:', paymentIntent.id);
        break;
      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
  }

  /**
   * Gérer un paiement réussi
   */
  async function handleSuccessfulPayment(session) {
    try {
      console.log('[handleSuccessfulPayment] ===== DÉBUT =====');
      console.log('[handleSuccessfulPayment] Session metadata:', session.metadata);
      
      const metadata = session.metadata || {};
      const reservationData = metadata.reservationData
        ? JSON.parse(metadata.reservationData)
        : {};
      
      console.log('[handleSuccessfulPayment] Reservation data parsed:', reservationData);
      
      const slotIdFromMetadata = metadata.slotId ? Number(metadata.slotId) : reservationData.slotId;
      const terrainIdFromMeta = metadata.terrainId ? Number(metadata.terrainId) : reservationData.terrainId;
      
      console.log('[handleSuccessfulPayment] slotId:', slotIdFromMetadata);
      console.log('[handleSuccessfulPayment] terrainId:', terrainIdFromMeta);

      // Créer la réservation dans la base de données
      const { organizer = {}, invitedPlayers = [], court = {}, date, slot, slotStart, slotEnd, totalPrice = 0, splitPayment, pricePerPerson } = reservationData;
      const slotStartValue = slotStart || metadata.slotStart;
      const slotEndValue = slotEnd || metadata.slotEnd || slotStartValue;
      const clubIdForTerrain = metadata.clubId || court.club_id || court.clubId;
      
      console.log('[handleSuccessfulPayment] Extracted values:');
      console.log('  - date:', date);
      console.log('  - slotStartValue:', slotStartValue);
      console.log('  - slotEndValue:', slotEndValue);
      console.log('  - clubIdForTerrain:', clubIdForTerrain);
      console.log('  - court.name:', court.name);

      // Trouver le terrain_id à partir du court
      let terrains = [];
      if (clubIdForTerrain && court.name) {
        const [rows] = await pool.query(
          'SELECT id FROM terrains WHERE club_id = ? AND name = ? LIMIT 1',
          [clubIdForTerrain, court.name]
        );
        terrains = rows;
      }

      let terrainId = terrainIdFromMeta;
      if (!terrainId && terrains && terrains.length > 0) {
        terrainId = terrains[0].id;
      }
      if (!terrainId && court.id) {
        terrainId = court.id;
      }

      console.log('[handleSuccessfulPayment] Final terrainId:', terrainId);

      if (!terrainId) {
        console.error('[handleSuccessfulPayment] ❌ Terrain non trouvé pour la réservation (aucun ID disponible)');
        return;
      }

      // Trouver ou créer l'utilisateur
      let userId;
      const [users] = await pool.query('SELECT id FROM users WHERE email = ?', [organizer.email]);
      
      if (users && users.length > 0) {
        userId = users[0].id;
      } else {
        // Créer un nouvel utilisateur
        const [result] = await pool.query(
          'INSERT INTO users (name, email, phone, created_at) VALUES (?, ?, ?, NOW())',
          [`${organizer.firstName} ${organizer.lastName}`, organizer.email, organizer.phone]
        );
        userId = result.insertId;
      }

      // Extraire l'heure de début et de fin du slot AVANT de créer la réservation
      const slotLabel = slot || metadata.slot || '';
      const [startTimeRaw, endTimeRaw] = slotLabel.includes('-')
        ? slotLabel.split(' - ')
        : [slotStartValue, slotEndValue];

      const normalizeTime = (timeStr) => {
        if (!timeStr) return null;
        const trimmed = timeStr.trim();
        if (/^\d{2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed;
        if (/^\d{2}:\d{2}$/.test(trimmed)) return `${trimmed}:00`;
        const dateObj = new Date(`1970-01-01T${trimmed}`);
        if (!isNaN(dateObj.getTime())) {
          return dateObj.toISOString().substring(11, 19);
        }
        return trimmed;
      };

      const normalizedStart = normalizeTime(startTimeRaw);
      const normalizedEnd = normalizeTime(endTimeRaw);
      
      console.log('[handleSuccessfulPayment] Time normalization:');
      console.log('  - startTimeRaw:', startTimeRaw, '→ normalized:', normalizedStart);
      console.log('  - endTimeRaw:', endTimeRaw, '→ normalized:', normalizedEnd);

      // Combiner date + heure pour créer des DATETIME
      const startDateTime = `${date} ${normalizedStart}`;
      const endDateTime = `${date} ${normalizedEnd}`;
      
      console.log('[handleSuccessfulPayment] DateTime values:');
      console.log('  - startDateTime:', startDateTime);
      console.log('  - endDateTime:', endDateTime);

      // Créer la réservation AVEC start_time et end_time en DATETIME
      const [reservationResult] = await pool.query(
        'INSERT INTO reservations (user_id, terrain_id, start_time, end_time, price, status, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
        [userId, terrainId, startDateTime, endDateTime, splitPayment ? pricePerPerson : totalPrice, 'confirmed']
      );

      const reservationId = reservationResult.insertId;
      console.log('[handleSuccessfulPayment] Réservation créée, ID:', reservationId);
      
      console.log('[handleSuccessfulPayment] Time normalization:');
      console.log('  - startTimeRaw:', startTimeRaw, '→ normalized:', normalizedStart);
      console.log('  - endTimeRaw:', endTimeRaw, '→ normalized:', normalizedEnd);

      const updateSlotById = async (slotId) => {
        if (!slotId) return 0;
        console.log('[handleSuccessfulPayment] Tentative UPDATE slot par ID:', slotId);
        const [result] = await pool.query(
          'UPDATE slots SET status = ?, reservation_id = ?, updated_at = NOW() WHERE id = ? AND status = ?',
          ['booked', reservationId, slotId, 'free']
        );
        const affected = result.affectedRows || result.affected_rows || 0;
        console.log('[handleSuccessfulPayment] Lignes affectées:', affected);
        return affected;
      };

      let updatedRows = 0;
      if (slotIdFromMetadata) {
        console.log('[handleSuccessfulPayment] 🔍 Mise à jour par slotId:', slotIdFromMetadata);
        updatedRows = await updateSlotById(slotIdFromMetadata);
        if (updatedRows === 0) {
          console.warn(`[handleSuccessfulPayment] ⚠️ Slot ${slotIdFromMetadata} introuvable ou déjà réservé.`);
        } else {
          console.log(`[handleSuccessfulPayment] ✅ Slot ${slotIdFromMetadata} mis à jour avec succès!`);
        }
      }

      if (updatedRows === 0) {
        console.log('[handleSuccessfulPayment] 🔍 Fallback: recherche slot par critères');
        console.log('[handleSuccessfulPayment] Critères: terrain_id =', terrainIdFromMeta || terrainId, ', date =', date, ', start =', normalizedStart, ', end =', normalizedEnd);
        
        const [slots] = await pool.query(
          'SELECT id FROM slots WHERE terrain_id = ? AND date = ? AND start_time = ? AND end_time = ? AND status = ? LIMIT 1',
          [terrainIdFromMeta || terrainId, date, normalizedStart, normalizedEnd, 'free']
        );

        console.log('[handleSuccessfulPayment] Slots trouvés:', slots);

        if (slots && slots.length > 0) {
          await pool.query(
            'UPDATE slots SET status = ?, reservation_id = ?, updated_at = NOW() WHERE id = ?',
            ['booked', reservationId, slots[0].id]
          );
          console.log(`[handleSuccessfulPayment] ✅ Slot ${slots[0].id} mis à jour : status = booked, reservation_id = ${reservationId}`);
        } else {
          console.warn(`[handleSuccessfulPayment] ⚠️ Aucun slot libre trouvé, création d'un nouveau slot (terrain ${terrainId}, ${date} ${normalizedStart}-${normalizedEnd})`);
          await pool.query(
            'INSERT INTO slots (terrain_id, club_id, date, start_time, end_time, status, reservation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
            [terrainId, metadata.clubId || null, date, normalizedStart, normalizedEnd, 'booked', reservationId]
          );
        }
      }

      // Ajouter les participants invités
      if (invitedPlayers && invitedPlayers.length > 0) {
        for (const player of invitedPlayers) {
          if (player.email || player.firstName) {
            await pool.query(
              'INSERT INTO reservation_participants (reservation_id, name, email, created_at) VALUES (?, ?, ?, NOW())',
              [reservationId, `${player.firstName} ${player.lastName}`.trim(), player.email]
            );
          }
        }
      }

      console.log(`Réservation ${reservationId} créée avec succès suite au paiement`);

    } catch (error) {
      console.error('Erreur lors de la création de la réservation:', error);
    }
  }

  /**
   * Récupérer les détails d'une session de paiement
   * GET /api/payments/session/:sessionId
   */
  async function getSessionDetails(req, res) {
    try {
      const { sessionId } = req.params;
      
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      
      res.json({
        id: session.id,
        status: session.payment_status,
        customerEmail: session.customer_email,
        amountTotal: session.amount_total / 100, // Convertir de centimes en euros
        metadata: session.metadata,
      });

    } catch (error) {
      console.error('Erreur récupération session:', error);
      res.status(500).json({ error: 'Erreur lors de la récupération de la session', details: error.message });
    }
  }

  /**
   * Confirmer un paiement (pour dev sans webhook)
   * POST /api/payments/confirm-payment
   */
  async function confirmPayment(req, res) {
    try {
      const { sessionId } = req.body;
      
      if (!sessionId) {
        return res.status(400).json({ error: 'Session ID manquant' });
      }

      console.log(`[confirmPayment] Récupération session ${sessionId}`);
      
      // Récupérer la session Stripe
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      
      console.log(`[confirmPayment] Session status: ${session.payment_status}`);
      
      if (session.payment_status === 'paid') {
        // Appeler la fonction de traitement comme le webhook
        await handleSuccessfulPayment(session);
        
        res.json({ 
          success: true, 
          message: 'Paiement confirmé et réservation créée' 
        });
      } else {
        res.status(400).json({ 
          error: 'Paiement non confirmé', 
          status: session.payment_status 
        });
      }

    } catch (error) {
      console.error('Erreur confirmation paiement:', error);
      res.status(500).json({ 
        error: 'Erreur lors de la confirmation du paiement', 
        details: error.message 
      });
    }
  }

  return {
    createCheckoutSession,
    handleWebhook,
    confirmPayment,
    getSessionDetails,
  };
};
