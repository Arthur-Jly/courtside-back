/**
 * Service pour interroger l'API data.gouv.fr des équipements sportifs
 * Documentation: https://equipements.sports.gouv.fr/api/explore/v2.1/
 */

const axios = require('axios');

const DATAGOUV_API_BASE = 'https://equipements.sports.gouv.fr/api/explore/v2.1/catalog/datasets/data-es/records';

// Mapping des sports de notre appli vers les filtres data.gouv
// Chaque sport peut avoir :
// - aps_name : le nom de l'activité sportive (obligatoire)
// - equip_type_name : le type d'équipement principal (un seul, le plus courant)
// Note: L'API utilise "refine" pour filtrer exactement sur ces champs
// Plusieurs refine sur le même champ = AND (pas OR), donc on prend UN SEUL type par sport
const SPORT_FILTERS_MAPPING = {
  'tennis': {
    aps_name: 'Tennis',
    equip_type_name: 'Court de tennis'
  },
  'football': {
    aps_name: 'Football / Football en salle (Futsal)',
    equip_type_name: 'Terrain de football'
  },
  'basketball': {
    aps_name: 'Basket-Ball',
    equip_type_name: 'Terrain de basket-ball'
  },
  'badminton': {
    aps_name: 'Badminton, Jeu de volant',
    equip_type_name: 'Terrain de badminton'
  },
  'volleyball': {
    aps_name: 'Volley-ball / Volley-ball de plage (beach-volley) / Green-Volley',
    equip_type_name: 'Terrain de volley-ball'
  },
  'squash': {
    aps_name: 'Squash',
    equip_type_name: 'Salle ou terrain de squash'
  },
  'padel': {
    aps_name: 'Padel tennis',
    equip_type_name: 'Terrain de padel'
  },
  'rugby': {
    aps_name: 'Rugby à 15 / Rugby à 7',
    equip_type_name: 'Terrain de rugby'
  },
  'handball': {
    aps_name: 'Handball / Mini hand / Handball de plage',
    equip_type_name: 'Terrain de handball'
  },
};

/**
 * Obtenir les filtres data.gouv pour un sport
 * @param {string} sport - Sport recherché
 * @returns {Object|null} Objet avec aps_name et/ou equip_type_name ou null
 */
const SPORT_ALIASES = {
  'basket': 'basketball',
  'foot': 'football',
  'futsal': 'football',
  'ping': 'badminton',
  'ping-pong': 'badminton',
  'table_tennis': 'badminton',
  'volley': 'volleyball',
  'hand': 'handball',
};

function getSportFilters(sport) {
  if (!sport || sport.toLowerCase() === 'all') {
    return null;
  }

  const sportLower = sport.toLowerCase();
  const normalized = SPORT_ALIASES[sportLower] || sportLower;
  return SPORT_FILTERS_MAPPING[normalized] || null;
}

/**
 * Obtenir les départements limitrophes
 * Mapping simplifié des départements voisins pour gérer les frontières
 * @param {string} depCode - Code département
 * @returns {Array<string>} Liste des départements limitrophes
 */
function getNeighboringDepartments(depCode) {
  // Mapping des principaux départements et leurs voisins
  // Peut être complété selon les besoins
  const neighbors = {
    '01': ['38', '39', '69', '71', '74'], // Ain
    '05': ['04', '26', '38', '73'], // Hautes-Alpes
    '13': ['04', '30', '83', '84'], // Bouches-du-Rhône
    '26': ['05', '07', '38', '84'], // Drôme
    '31': ['09', '11', '32', '65', '81', '82'], // Haute-Garonne
    '33': ['17', '24', '40', '47'], // Gironde
    '38': ['01', '05', '26', '69', '73', '74'], // Isère
    '42': ['03', '43', '63', '69', '71'], // Loire
    '44': ['35', '49', '56', '85'], // Loire-Atlantique
    '59': ['02', '62', '80'], // Nord
    '69': ['01', '38', '42', '71'], // Rhône
    '73': ['01', '05', '38', '74'], // Savoie
    '74': ['01', '38', '73'], // Haute-Savoie
    '75': ['92', '93', '94'], // Paris
    '92': ['75', '78', '91', '93', '94', '95'], // Hauts-de-Seine
    '93': ['75', '77', '92', '94', '95'], // Seine-Saint-Denis
    '94': ['75', '77', '91', '92', '93'], // Val-de-Marne
    // Ajoutez d'autres départements selon vos besoins
  };
  
  return neighbors[depCode] || [];
}

// Types d'équipements connus comme valides (vrais terrains praticables)
const VALID_EQUIP_TYPES = [
  'court de tennis',
  'terrain de football',
  'terrain de basket',
  'terrain de volley',
  'terrain de badminton',
  'terrain de handball',
  'terrain de rugby',
  'terrain de padel',
  'salle ou terrain de squash',
  'terrain multisports',
  'city stade',
  'plateau eps',
  'terrain de pétanque',
  'terrain de beach',
  'salle de sports',
  'gymnase',
  'halle de sports',
  'complexe sportif',
  'terrain de sport',
  'skate park',
  'mur de tennis',
];

// Patterns qui indiquent un espace vague / non praticable
const INVALID_TYPE_PATTERNS = [
  'espace naturel',
  'terrain vague',
  'espace libre',
  'piste cyclable',
  'chemin',
  'sentier',
  'parcours de santé',
  'aire de jeux',
  'aire de repos',
  'espace vert',
];

const INVALID_NAME_PATTERNS = [
  'terrain vague',
  'espace vert',
  'terrain nu',
  'non renseigné',
  'sans nom',
  'inconnu',
];

/**
 * Vérifie si un équipement est un vrai terrain praticable
 * @param {Object} eq - Équipement data.gouv
 * @returns {boolean}
 */
function isValidEquipement(eq) {
  // Doit avoir un nom d'installation non vide (min 3 chars)
  if (!eq.inst_nom || eq.inst_nom.trim().length < 3) return false;

  // Doit avoir un type d'équipement
  if (!eq.equip_type_name || eq.equip_type_name.trim() === '') return false;

  // Doit être ouvert au public
  if (eq.equip_ouv_public_bool === 'false') return false;

  const typeLower = eq.equip_type_name.toLowerCase();
  const nameLower = eq.inst_nom.toLowerCase();

  // Rejeter les types invalides connus
  if (INVALID_TYPE_PATTERNS.some(p => typeLower.includes(p))) return false;

  // Rejeter les noms invalides connus
  if (INVALID_NAME_PATTERNS.some(p => nameLower.includes(p))) return false;

  // Accepter si le type match un type valide connu
  if (VALID_EQUIP_TYPES.some(t => typeLower.includes(t))) return true;

  // Accepter si le type contient "terrain", "salle", "court", "stade", "piste", "piscine"
  const VALID_KEYWORDS = ['terrain', 'salle', 'court', 'stade', 'gymnase', 'halle', 'complexe', 'piscine', 'city', 'plateau'];
  if (VALID_KEYWORDS.some(k => typeLower.includes(k))) return true;

  // Par défaut rejeter si le type n'est pas reconnu
  return false;
}

/**
 * Récupérer les équipements d'un ou plusieurs départements
 * @private
 * @param {Array<string>} depCodes - Codes des départements
 * @param {Object} sportFilters - Filtres de sport (aps_name, equip_type_name)
 * @param {number} maxResults - Nombre maximum de résultats par département
 * @returns {Promise<Array>} Tous les équipements
 */
async function fetchEquipementsByDepartments(depCodes, sportFilters, maxResults = 1000) {
  let allResults = [];
  
  for (const depCode of depCodes) {
    console.log(`[DataGouvAPI] Récupération des équipements du département ${depCode}...`);
    
    const urlParams = new URLSearchParams();
    
    // Filtre par département
    urlParams.append('refine', `dep_code:${depCode}`);
    
    // Filtre par sport
    if (sportFilters) {
      if (sportFilters.aps_name) {
        urlParams.append('refine', `aps_name:${sportFilters.aps_name}`);
      }
      if (sportFilters.equip_type_name) {
        urlParams.append('refine', `equip_type_name:${sportFilters.equip_type_name}`);
      }
    }
    
    // Filtre ACCÈS LIBRE + ouverture public
    urlParams.append('refine', 'equip_acc_libre:true');
    urlParams.append('refine', 'equip_ouv_public_bool:true');
    
    // Sélectionner uniquement les champs utiles
    urlParams.append('select', [
      'equip_numero',
      'inst_numero',
      'inst_nom',
      'inst_adresse',
      'inst_cp',
      'new_name',
      'new_code',
      'inst_part_type_filter',
      'equip_nom',
      'equip_type_name',
      'equip_coordonnees',
      'equip_prop_nom',
      'equip_ouv_public_bool',
      'equip_acc_libre',
      'equip_nature',
      'equip_sol',
      'equip_eclair',
      'aps_name',
      'dep_code',
      'dep_nom',
    ].join(','));
    
    const baseUrl = `${DATAGOUV_API_BASE}?${urlParams.toString()}`;
    
    try {
      const results = await fetchAllPaginated(baseUrl, maxResults);
      console.log(`[DataGouvAPI] ${results.length} équipements récupérés pour le département ${depCode}`);
      allResults = allResults.concat(results);
    } catch (error) {
      console.error(`[DataGouvAPI] Erreur pour le département ${depCode}:`, error.message);
    }
  }
  
  return allResults;
}

/**
 * Obtenir le code département à partir de coordonnées GPS
 * Utilise l'API geo.api.gouv.fr pour la géolocalisation inverse
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @returns {Promise<string|null>} Code département ou null
 */
async function getDepCodeFromCoords(lat, lon) {
  try {
    const url = `https://geo.api.gouv.fr/communes?lat=${lat}&lon=${lon}&fields=codeDepartement&limit=1`;
    const response = await axios.get(url, { timeout: 5000 });
    
    if (response.data && response.data.length > 0 && response.data[0].codeDepartement) {
      const depCode = response.data[0].codeDepartement;
      console.log(`[DataGouvAPI] Département détecté: ${depCode}`);
      return depCode;
    }
    
    return null;
  } catch (error) {
    console.error('[DataGouvAPI] Erreur détection département:', error.message);
    return null;
  }
}

/**
 * Récupère tous les résultats paginés de l'API
 * @private
 * @param {string} baseUrl - URL de base avec tous les paramètres sauf limit et offset
 * @param {number} maxResults - Nombre maximum de résultats à récupérer (sécurité)
 * @returns {Promise<Array>} Tous les résultats paginés
 */
async function fetchAllPaginated(baseUrl, maxResults = 1000) {
  const pageSize = 100; // Limite max de l'API
  let offset = 0;
  let allResults = [];
  
  console.log('[DataGouvAPI] Début de la pagination...');
  
  while (allResults.length < maxResults) {
    const url = `${baseUrl}&limit=${pageSize}&offset=${offset}`;
    
    try {
      const response = await axios.get(url, { timeout: 10000 });
      
      if (!response.data || !response.data.results || response.data.results.length === 0) {
        // Plus de résultats
        break;
      }
      
      allResults = allResults.concat(response.data.results);
      console.log(`[DataGouvAPI] Page ${Math.floor(offset / pageSize) + 1}: ${response.data.results.length} résultats (total: ${allResults.length}/${response.data.total_count})`);
      
      // Si on a récupéré tous les résultats disponibles
      if (allResults.length >= response.data.total_count) {
        break;
      }
      
      offset += pageSize;
      
      // Petite pause pour ne pas surcharger l'API
      await new Promise(resolve => setTimeout(resolve, 100));
      
    } catch (error) {
      console.error(`[DataGouvAPI] Erreur page ${Math.floor(offset / pageSize) + 1}:`, error.message);
      break;
    }
  }
  
  console.log(`[DataGouvAPI] Pagination terminée: ${allResults.length} résultats au total`);
  return allResults;
}

/**
 * Rechercher des équipements sportifs via l'API data.gouv.fr
 * Utilise la pagination pour récupérer tous les équipements d'un département,
 * puis filtre et trie par distance côté serveur
 * @param {Object} filters - Filtres de recherche
 * @param {number} filters.lat - Latitude
 * @param {number} filters.lon - Longitude
 * @param {string} filters.sport - Sport à filtrer (optionnel)
 * @param {number} filters.radius - Rayon de recherche en km (défaut: 10)
 * @param {number} filters.limit - Limite de résultats (défaut: 50)
 * @param {string} filters.dep_code - Code département (optionnel, ex: "38" pour Isère)
 * @returns {Promise<Array>} Liste des équipements
 */
async function searchEquipements(filters = {}) {
  try {
    const { lat, lon, sport, radius = 10, limit = 50, dep_code, includeNeighboring = false } = filters;
    
    // Stratégie :
    // 1. Si dep_code fourni : chercher dans ce département uniquement
    // 2. Si lat/lon fournis : détecter le département principal SEULEMENT
    //    (pas de départements limitrophes sauf si includeNeighboring=true)
    
    const sportFilters = getSportFilters(sport);
    let results = [];
    
    if (dep_code) {
      // Recherche par département explicite uniquement
      console.log(`[DataGouvAPI] Recherche dans le département ${dep_code}`);
      results = await fetchEquipementsByDepartments([dep_code], sportFilters, 1000);
      
    } else if (lat && lon) {
      // Recherche géographique : département principal (+ limitrophes si demandé)
      const mainDepCode = await getDepCodeFromCoords(lat, lon);
      
      if (mainDepCode) {
        let depsToSearch = [mainDepCode];
        
        // Ajouter les départements limitrophes seulement si explicitement demandé
        if (includeNeighboring) {
          const neighboringDeps = getNeighboringDepartments(mainDepCode);
          depsToSearch = [mainDepCode, ...neighboringDeps];
          console.log(`[DataGouvAPI] Recherche approfondie dans ${depsToSearch.length} départements`);
        } else {
          console.log(`[DataGouvAPI] Recherche dans le département ${mainDepCode} uniquement`);
        }
        
        // Récupérer les équipements
        results = await fetchEquipementsByDepartments(depsToSearch, sportFilters, 1000);
      } else {
        console.log('[DataGouvAPI] Impossible de détecter le département');
        return [];
      }
    } else {
      console.log('[DataGouvAPI] Aucun critère de recherche géographique fourni');
      return [];
    }
    
    console.log(`[DataGouvAPI] ${results.length} équipements récupérés au total`);
    
    // Si on a des coordonnées, filtrer par distance
    if (lat && lon) {
      // Rejeter les terrains vagues / espaces non praticables
      const beforeQualityFilter = results.length;
      results = results.filter(isValidEquipement);
      console.log(`[DataGouvAPI] Filtre qualité: ${beforeQualityFilter} → ${results.length} équipements valides`);

      // Filtrer les équipements sans coordonnées
      results = results.filter(eq => eq.equip_coordonnees && eq.equip_coordonnees.lat && eq.equip_coordonnees.lon);
      
      // Calculer la distance pour chaque équipement
      results = results.map(eq => ({
        ...eq,
        _distance_km: calculateDistance(lat, lon, eq.equip_coordonnees.lat, eq.equip_coordonnees.lon)
      }));
      
      // Filtrer par le rayon demandé
      const requestedRadius = parseFloat(radius);
      results = results.filter(eq => eq._distance_km <= requestedRadius);
      
      // DÉDUPLICATION STRICTE : par nom d'installation + ville
      // Un seul équipement par installation (même s'il y a plusieurs courts)
      const uniqueEquipments = new Map();
      results.forEach(eq => {
        // Créer une clé unique basée sur : nom installation + ville
        const name = (eq.inst_nom || '').trim().toLowerCase();
        const city = (eq.new_name || '').trim().toLowerCase();
        
        const uniqueKey = `${name}|${city}`;
        
        // Garder seulement le premier (le plus proche) avec cette combinaison
        if (!uniqueEquipments.has(uniqueKey)) {
          uniqueEquipments.set(uniqueKey, eq);
        }
      });
      
      results = Array.from(uniqueEquipments.values());
      
      // Trier par distance croissante
      results.sort((a, b) => a._distance_km - b._distance_km);
      
      console.log(`[DataGouvAPI] Après déduplication et filtrage par distance (${requestedRadius}km): ${results.length} équipements uniques`);
      
      if (results.length > 0) {
        const uniqueDeps = [...new Set(results.map(eq => eq.dep_code))].filter(Boolean);
        console.log(`[DataGouvAPI] Départements dans les résultats: ${uniqueDeps.join(', ')}`);
        console.log(`[DataGouvAPI] Le plus proche: ${results[0].inst_nom} (${results[0].new_name}, dép. ${results[0].dep_code}) à ${results[0]._distance_km.toFixed(2)}km`);
      }
    }
    
    // Limiter au nombre demandé
    results = results.slice(0, parseInt(limit, 10));
    
    return results;
    
  } catch (error) {
    console.error('[DataGouvAPI] Erreur lors de la recherche:', error.message);
    if (error.response) {
      console.error('[DataGouvAPI] Status:', error.response.status);
      console.error('[DataGouvAPI] Data:', error.response.data);
    }
    return [];
  }
}

/**
 * Transformer un équipement data.gouv en format compatible avec nos clubs
 * @param {Object} equipement - Équipement data.gouv
 * @param {number} userLat - Latitude de l'utilisateur (pour calcul distance)
 * @param {number} userLon - Longitude de l'utilisateur
 * @returns {Object} Club formaté
 */
function transformEquipementToClub(equipement, userLat = null, userLon = null) {
  const club = {
    // ID unique pour éviter collision avec les clubs BDD
    id: `datagouv_${equipement.equip_numero}`,
    source: 'data.gouv.fr',
    
    // Identifiant unique de l'équipement (pour lier les annonces)
    equip_numero: equipement.equip_numero,
    
    // Informations de base
    name: equipement.inst_nom || 'Équipement sportif',
    address: equipement.inst_adresse || '',
    city: equipement.new_name || '',
    postal_code: equipement.inst_cp || '',
    
    // Coordonnées GPS
    lat: equipement.equip_coordonnees?.lat || null,
    lon: equipement.equip_coordonnees?.lon || null,
    lng: equipement.equip_coordonnees?.lon || null, // Alias pour compatibilité
    
    // Sports disponibles
    sports: equipement.aps_name || [equipement.equip_type_name],
    
    // Informations supplémentaires
    equipement_nom: equipement.equip_nom,
    equipement_type: equipement.equip_type_name,
    proprietaire: equipement.equip_prop_nom,
    ouverture_public: equipement.equip_ouv_public_bool === 'true',
    nature: equipement.equip_nature, // Intérieur/Extérieur
    eclairage: equipement.equip_eclair === 'true',
    type_installation: equipement.inst_part_type_filter,
    
    // Département
    dep_code: equipement.dep_code,
    dep_nom: equipement.dep_nom,
    
    // Pas d'images pour data.gouv
    images: [],
    
    // Pas de prix pour équipements publics
    min_price: null,
    max_price: null,
    
    // Note : équipements publics n'ont pas de rating
    rating: null,
  };
  
  // Calculer la distance si coordonnées utilisateur fournies
  if (userLat && userLon && club.lat && club.lon) {
    club.distance_km = calculateDistance(userLat, userLon, club.lat, club.lon);
  }
  
  return club;
}

/**
 * Calcule la distance entre deux points GPS (formule haversine)
 * @param {number} lat1 - Latitude point 1
 * @param {number} lon1 - Longitude point 1
 * @param {number} lat2 - Latitude point 2
 * @param {number} lon2 - Longitude point 2
 * @returns {number} Distance en kilomètres
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Rayon de la Terre en km
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;
  
  return Math.round(distance * 100) / 100; // Arrondir à 2 décimales
}

function toRadians(degrees) {
  return degrees * (Math.PI / 180);
}

module.exports = {
  searchEquipements,
  transformEquipementToClub,
  calculateDistance,
  isValidEquipement,
  SPORT_FILTERS_MAPPING,
};
