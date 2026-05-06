# API Clubs - Documentation

## Endpoints disponibles

### GET /api/clubs

Récupère la liste des clubs avec filtres optionnels.

**Query Parameters:**
- `lat` (number, optionnel) : Latitude du point de recherche
- `lon` (number, optionnel) : Longitude du point de recherche
- `sport` (string, optionnel) : Filtre par sport (ex: "tennis", "football")
  - Utiliser "all" pour récupérer tous les sports
- `radius` (number, optionnel) : Rayon de recherche en km (ex: 10)
- `limit` (number, optionnel) : Nombre maximal de résultats (défaut: 50)

**Exemple de requête:**
```
GET /api/clubs?lat=48.8566&lon=2.3522&sport=tennis&radius=5&limit=20
```

**Réponse (200 OK):**
```json
[
  {
    "id": 1,
    "name": "Club Tennis Elite",
    "address": "123 Avenue des Sports",
    "city": "Paris",
    "lat": 48.8606,
    "lon": 2.3376,
    "lng": 2.3376,
    "rating": 4.5,
    "sports": ["tennis", "padel"],
    "images": ["https://...", "https://..."],
    "distance_km": 0.5
  }
]
```

**Erreur (500):**
```json
{
  "error": "Erreur lors de la récupération des clubs",
  "details": "Message d'erreur (en développement uniquement)"
}
```

---

### GET /api/clubs/:id

Récupère un club spécifique par son ID.

**URL Parameters:**
- `id` (number, requis) : ID du club à récupérer

**Exemple de requête:**
```
GET /api/clubs/1
```

**Réponse (200 OK):**
```json
{
  "id": 1,
  "name": "Club Tennis Elite",
  "address": "123 Avenue des Sports",
  "city": "Paris",
  "lat": 48.8606,
  "lon": 2.3376,
  "lng": 2.3376,
  "rating": 4.5,
  "sports": ["tennis", "padel"],
  "images": ["https://...", "https://..."]
}
```

**Erreur (404 Not Found):**
```json
{
  "error": "Club introuvable"
}
```

---

### GET /api/clubs/:id/terrains

Récupère les terrains d'un club spécifique.

**URL Parameters:**
- `id` (number, requis) : ID du club

**Exemple de requête:**
```
GET /api/clubs/1/terrains
```

**Réponse (200 OK):**
```json
[
  {
    "id": 1,
    "club_id": 1,
    "name": "Court Central",
    "sport_type": "tennis",
    "price_per_hour": 35.00,
    "slot_duration": 90,
    "created_at": "2025-01-15T10:30:00.000Z"
  },
  {
    "id": 2,
    "club_id": 1,
    "name": "Court N°2",
    "sport_type": "tennis",
    "price_per_hour": 30.00,
    "slot_duration": 90,
    "created_at": "2025-01-15T10:30:00.000Z"
  }
]
```

---

### GET /api/partners

Récupère une liste simplifiée des partenaires (pour compatibilité).

**Exemple de requête:**
```
GET /api/partners
```

**Réponse (200 OK):**
```json
[
  {
    "id": 1,
    "name": "Club Tennis Elite",
    "address": "123 Avenue des Sports",
    "city": "Paris",
    "lat": 48.8606,
    "lon": 2.3376,
    "lng": 2.3376
  }
]
```

---

### GET /api/db-status

Vérifie le statut de la base de données.

**Exemple de requête:**
```
GET /api/db-status
```

**Réponse (200 OK):**
```json
{
  "status": "ok",
  "clubs": 42,
  "users": 156
}
```

**Erreur (500):**
```json
{
  "status": "error",
  "message": "DB unreachable",
  "details": {...}
}
```

---

## Architecture back-end

### Contrôleur : `clubs.controller.js`

Le contrôleur centralise toute la logique métier :
- Validation des filtres
- Construction des requêtes SQL dynamiques avec calcul de distance (Haversine)
- Gestion des erreurs
- Transformation des données (GROUP_CONCAT → arrays)
- Alias `lng` pour compatibilité front

**Méthodes principales:**
- `getClubs(filters)` : Récupère les clubs avec filtres et distance
- `getClubById(id)` : Récupère un club par ID
- `getTerrainsByClubId(clubId)` : Récupère les terrains d'un club
- `getPartners()` : Liste simplifiée des partenaires

### Route : `clubs.js`

La route utilise le contrôleur pour gérer les requêtes HTTP :
- Parsing des query params
- Appel au contrôleur avec async/await
- Gestion des réponses et erreurs HTTP
- Logging des erreurs

---

## Calcul de distance

Le contrôleur utilise la **formule de Haversine** pour calculer la distance entre deux points géographiques :

```sql
( 6371 * acos(
    cos(radians(?)) * cos(radians(c.lat)) * cos(radians(c.lon) - radians(?))
    + sin(radians(?)) * sin(radians(c.lat))
) ) AS distance_km
```

- `6371` = Rayon de la Terre en km
- Résultat en kilomètres
- Tri automatique par distance croissante

---

## Améliorations implémentées

✅ **Séparation des responsabilités** : Route vs Contrôleur  
✅ **Async/await** : Gestion moderne des opérations asynchrones  
✅ **Filtrage par sport** : Recherche LIKE dans club_sports  
✅ **Calcul de distance** : Formule Haversine intégrée  
✅ **Tri automatique** : Par distance croissante  
✅ **Gestion d'erreurs robuste** : Try/catch et codes HTTP appropriés  
✅ **Validation** : Filtres validés avant requête SQL  
✅ **Sécurité** : Requêtes paramétrées (protection SQL injection)  
✅ **Logging** : console.error pour debug  
✅ **Environnement** : Détails d'erreur uniquement en développement  
✅ **Transformation données** : GROUP_CONCAT → arrays JavaScript  
✅ **Alias compatibilité** : `lng` pour le front (en plus de `lon`)

---

## Base de données

### Tables utilisées

- `clubs` : Informations principales des clubs
- `club_sports` : Sports disponibles par club (relation many-to-many)
- `club_images` : Images des clubs
- `terrains` : Terrains disponibles par club

### Schéma (extrait)

```sql
clubs (id, name, address, city, lat, lon, rating)
club_sports (id, club_id, sport_name)
club_images (id, club_id, image_url)
terrains (id, club_id, name, sport_type, price_per_hour, slot_duration)
```
