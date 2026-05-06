module.exports = function(db) {
  const pool = (db && typeof db.promise === 'function') ? db.promise() : db;

  // GET /clubs/:id/finances?period=day|week|month|year|total&date=YYYY-MM-DD
  async function getClubFinances(req, res) {
    try {
      const clubId = req.params.id;
      const period = req.query.period || 'month'; // day, week, month, year, total
      const targetDate = req.query.date ? new Date(req.query.date) : new Date();

      // Calculate date range based on period
      let startDate, endDate;
      
      if (period === 'total') {
        // Toutes les réservations depuis le début
        startDate = new Date('2000-01-01');
        endDate = new Date('2099-12-31');
      } else if (period === 'day') {
        // Aujourd'hui seulement
        startDate = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
        endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
      } else if (period === 'week') {
        // Cette semaine (lundi à dimanche)
        const day = targetDate.getDay();
        const diff = targetDate.getDate() - day + (day === 0 ? -6 : 1); // Ajuster quand c'est dimanche
        startDate = new Date(targetDate.getFullYear(), targetDate.getMonth(), diff);
        endDate = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);
      } else if (period === 'year') {
        // Cette année (du 1er janvier au 31 décembre)
        startDate = new Date(targetDate.getFullYear(), 0, 1);
        endDate = new Date(targetDate.getFullYear() + 1, 0, 1);
      } else { // month
        // Ce mois (du 1er au dernier jour du mois)
        startDate = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);
        endDate = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 1);
      }

      const startDateStr = startDate.toISOString().slice(0, 10);
      const endDateStr = endDate.toISOString().slice(0, 10);
      
      console.log('=== FINANCES DEBUG ===');
      console.log('Period:', period);
      console.log('Target Date:', targetDate);
      console.log('Start Date:', startDateStr);
      console.log('End Date:', endDateStr);

      // Get all reservations with prices for the club in the period
      const [reservations] = await pool.query(`
        SELECT 
          r.id,
          r.price,
          r.status,
          r.created_at,
          t.name as terrain_name,
          t.id as terrain_id,
          u.name as user_name,
          s.date as reservation_date,
          s.start_time,
          s.end_time
        FROM reservations r
        JOIN slots s ON r.id = s.reservation_id
        JOIN terrains t ON s.terrain_id = t.id
        JOIN users u ON r.user_id = u.id
        WHERE t.club_id = ? 
          AND s.date >= ? 
          AND s.date < ?
          AND r.status = 'confirmed'
        ORDER BY s.date DESC, s.start_time DESC
      `, [clubId, startDateStr, endDateStr]);

      // Calculate metrics
      const totalRevenue = reservations.reduce((sum, r) => sum + (parseFloat(r.price) || 0), 0);
      const commissionRate = 0.10; // 10% commission
      const totalCommission = totalRevenue * commissionRate;
      const netRevenue = totalRevenue - totalCommission;
      const averageTransaction = reservations.length > 0 ? totalRevenue / reservations.length : 0;

      // Group by day/date for revenue evolution
      const revenueByDate = {};
      reservations.forEach(r => {
        const date = new Date(r.reservation_date);
        let dateKey;
        
        if (period === 'day') {
          // Par heure pour la journée
          dateKey = date.getHours() + 'h';
        } else if (period === 'week') {
          // Par jour de la semaine
          dateKey = date.toLocaleDateString('fr-FR', { weekday: 'short' });
        } else if (period === 'year') {
          // Par mois pour l'année
          dateKey = date.toLocaleDateString('fr-FR', { month: 'short' });
        } else if (period === 'total') {
          // Par mois pour le total
          dateKey = date.toLocaleDateString('fr-FR', { year: 'numeric', month: 'short' });
        } else {
          // Par jour du mois
          dateKey = date.getDate().toString();
        }
        
        if (!revenueByDate[dateKey]) {
          revenueByDate[dateKey] = { key: dateKey, revenue: 0, commission: 0, net: 0 };
        }
        const price = parseFloat(r.price) || 0;
        revenueByDate[dateKey].revenue += price;
        revenueByDate[dateKey].commission += price * commissionRate;
        revenueByDate[dateKey].net += price * (1 - commissionRate);
      });

      const revenueData = Object.values(revenueByDate).map(m => ({
        [period === 'month' ? 'day' : period === 'week' ? 'day' : period === 'year' ? 'month' : period === 'total' ? 'month' : 'hour']: m.key,
        revenue: Math.round(m.revenue * 100) / 100,
        commission: Math.round(m.commission * 100) / 100,
        net: Math.round(m.net * 100) / 100,
      }));

      // Payment methods distribution - Default to "Carte bancaire" since payment_method column doesn't exist
      const paymentMethods = [
        { name: 'Carte bancaire', value: 100, color: '#10b981' }
      ];

      // Revenue by court
      const courtRevenueMap = {};
      reservations.forEach(r => {
        const courtName = r.terrain_name;
        if (!courtRevenueMap[courtName]) {
          courtRevenueMap[courtName] = 0;
        }
        courtRevenueMap[courtName] += parseFloat(r.price) || 0;
      });

      const courtRevenue = Object.entries(courtRevenueMap)
        .map(([court, revenue]) => ({
          court,
          revenue: Math.round(revenue * 100) / 100,
        }))
        .sort((a, b) => b.revenue - a.revenue);

      // Format payments for table
      const payments = reservations.slice(0, 50).map(r => {
        const price = parseFloat(r.price) || 0;
        const commission = price * commissionRate;
        const net = price - commission;
        
        // Formater la date proprement (jj/mm/aaaa)
        const reservationDate = new Date(r.reservation_date);
        const formattedDate = reservationDate.toLocaleDateString('fr-FR', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric'
        });

        return {
          id: r.id.toString(),
          date: formattedDate,
          description: `${r.terrain_name} - ${r.start_time.slice(0, 5)}`,
          amount: Math.round(price * 100) / 100,
          commission: Math.round(commission * 100) / 100,
          net: Math.round(net * 100) / 100,
          method: 'Carte bancaire',
          status: r.status === 'confirmed' ? 'completed' : 'pending',
        };
      });

      res.json({
        period,
        startDate: startDateStr,
        endDate: endDateStr,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalCommission: Math.round(totalCommission * 100) / 100,
        netRevenue: Math.round(netRevenue * 100) / 100,
        averageTransaction: Math.round(averageTransaction * 100) / 100,
        reservationsCount: reservations.length,
        revenueData,
        paymentMethods,
        courtRevenue,
        payments,
      });

    } catch (error) {
      console.error('Error fetching club finances:', error);
      res.status(500).json({ error: 'Error fetching financial data' });
    }
  }

  return {
    getClubFinances,
  };
};
