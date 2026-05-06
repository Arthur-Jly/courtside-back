/**
 * Script pour vérifier les coordonnées des clubs
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

async function checkClubsCoords() {
  let connection;

  try {
    console.log('🔌 Connexion à la base de données...\n');
    connection = await mysql.createConnection(dbConfig);

    const [clubs] = await connection.execute(
      'SELECT id, name, address, city, lat, lon FROM clubs ORDER BY id'
    );

    console.log('📍 ÉTAT DES COORDONNÉES DES CLUBS');
    console.log('='.repeat(80) + '\n');

    let withCoords = 0;
    let withoutCoords = 0;
    let invalidCoords = 0;

    clubs.forEach(club => {
      const hasLat = club.lat && club.lat !== 0;
      const hasLon = club.lon && club.lon !== 0;
      const hasValidCoords = hasLat && hasLon;

      if (hasValidCoords) {
        console.log(`✅ ${club.name}`);
        console.log(`   📍 ${club.lat}, ${club.lon}`);
        console.log(`   📫 ${club.address}, ${club.city}\n`);
        withCoords++;
      } else if (club.lat || club.lon) {
        console.log(`⚠️  ${club.name} - Coordonnées invalides`);
        console.log(`   📍 lat: ${club.lat || 'NULL'}, lon: ${club.lon || 'NULL'}`);
        console.log(`   📫 ${club.address}, ${club.city}\n`);
        invalidCoords++;
      } else {
        console.log(`❌ ${club.name} - Pas de coordonnées`);
        console.log(`   📫 ${club.address}, ${club.city}\n`);
        withoutCoords++;
      }
    });

    console.log('='.repeat(80));
    console.log('📊 RÉSUMÉ');
    console.log('='.repeat(80));
    console.log(`Total de clubs: ${clubs.length}`);
    console.log(`✅ Avec coordonnées valides: ${withCoords}`);
    console.log(`⚠️  Avec coordonnées invalides: ${invalidCoords}`);
    console.log(`❌ Sans coordonnées: ${withoutCoords}`);
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('❌ Erreur:', error);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

checkClubsCoords();
