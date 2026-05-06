/**
 * Script pour géocoder les adresses des clubs
 * Convertit les adresses en coordonnées GPS (lat/lon)
 */

const mysql = require('mysql2/promise');
require('dotenv').config();

// Configuration de la base de données
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'sport_db'
};

// Fonction pour géocoder une adresse avec l'API Google Maps
async function geocodeAddress(address) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  
  if (!apiKey) {
    console.error('❌ GOOGLE_MAPS_API_KEY manquante dans .env');
    return null;
  }

  const encodedAddress = encodeURIComponent(address);
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodedAddress}&key=${apiKey}`;

  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status === 'OK' && data.results.length > 0) {
      const location = data.results[0].geometry.location;
      return {
        lat: location.lat,
        lng: location.lng,
        formatted_address: data.results[0].formatted_address
      };
    } else {
      console.warn(`⚠️ Géocodage échoué pour "${address}": ${data.status}`);
      return null;
    }
  } catch (error) {
    console.error(`❌ Erreur lors du géocodage de "${address}":`, error.message);
    return null;
  }
}

// Fonction principale
async function geocodeClubs() {
  let connection;

  try {
    // Connexion à la base de données
    console.log('🔌 Connexion à la base de données...');
    connection = await mysql.createConnection(dbConfig);
    console.log('✅ Connecté à la base de données');

    // Récupérer tous les clubs
    const [clubs] = await connection.execute(
      'SELECT id, name, address, city, postal_code, lat, lon FROM clubs'
    );

    console.log(`\n📍 ${clubs.length} clubs trouvés\n`);

    let updated = 0;
    let failed = 0;
    let skipped = 0;

    // Parcourir chaque club
    for (const club of clubs) {
      // Vérifier si le club a déjà des coordonnées valides
      if (club.lat && club.lon && club.lat !== 0 && club.lon !== 0) {
        console.log(`⏭️  "${club.name}" - Coordonnées déjà présentes (${club.lat}, ${club.lon})`);
        skipped++;
        continue;
      }

      // Construire l'adresse complète
      const fullAddress = [
        club.address,
        club.postal_code,
        club.city
      ].filter(Boolean).join(', ');

      console.log(`🔍 Géocodage de "${club.name}" - ${fullAddress}`);

      // Géocoder l'adresse
      const result = await geocodeAddress(fullAddress);

      if (result) {
        // Mettre à jour les coordonnées dans la base de données
        await connection.execute(
          'UPDATE clubs SET lat = ?, lon = ? WHERE id = ?',
          [result.lat, result.lng, club.id]
        );

        console.log(`✅ "${club.name}" mis à jour: ${result.lat}, ${result.lng}`);
        console.log(`   Adresse formatée: ${result.formatted_address}\n`);
        updated++;
      } else {
        console.log(`❌ "${club.name}" - Impossible de géocoder\n`);
        failed++;
      }

      // Pause pour éviter de dépasser les limites de l'API
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Résumé
    console.log('\n' + '='.repeat(60));
    console.log('📊 RÉSUMÉ');
    console.log('='.repeat(60));
    console.log(`Total de clubs: ${clubs.length}`);
    console.log(`✅ Mis à jour: ${updated}`);
    console.log(`⏭️  Déjà géocodés: ${skipped}`);
    console.log(`❌ Échoués: ${failed}`);
    console.log('='.repeat(60) + '\n');

  } catch (error) {
    console.error('❌ Erreur:', error);
  } finally {
    if (connection) {
      await connection.end();
      console.log('🔌 Connexion fermée');
    }
  }
}

// Exécuter le script
geocodeClubs();
