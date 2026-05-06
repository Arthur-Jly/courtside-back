# API LastMinute - Documentation

## Endpoints disponibles

### GET /api/lastminute

Récupère la liste des créneaux last minute avec filtres optionnels.

**Query Parameters:**
- `sport` (string, optionnel) : Filtre par sport (ex: "football", "tennis", "basketball")
  - Utiliser "all" pour récupérer tous les sports
- `location` (string, optionnel) : Filtre par lieu (recherche dans `location` et `address`)

**Exemple de requête:**
```
GET /api/lastminute?sport=football&location=paris
```

**Réponse (200 OK):**
```json
{
  "last_minute_slots": [
    {
      "id": 1,
      "title": "Session Basketball",
      "location": "Gymnase République",
      "address": "45 Rue de la République, Paris 11e",
      "sport": "Basketball",
      "time": "Aujourd'hui 18h30",
      "currentPlayers": 6,
      "maxPlayers": 10,
      "level": "Intermédiaire",
      "distance": "1.2km",
      "description": "Match amical entre amis...",
      "organizer": "Alex M.",
      "image": "https://...",
      "created_at": "2025-09-10T14:03:08.000Z"
    }
  ],
  "count": 1
}
```

**Erreur (500):**
```json
{
  "error": "Erreur lors de la récupération des créneaux last minute",
  "details": "Message d'erreur (en développement uniquement)"
}
```

---

### GET /api/lastminute/:id

Récupère un créneau spécifique par son ID.

**URL Parameters:**
- `id` (number, requis) : ID du créneau à récupérer

**Exemple de requête:**
```
GET /api/lastminute/1
```

**Réponse (200 OK):**
```json
{
  "slot": {
    "id": 1,
    "title": "Session Basketball",
    "location": "Gymnase République",
    "address": "45 Rue de la République, Paris 11e",
    "sport": "Basketball",
    "time": "Aujourd'hui 18h30",
    "currentPlayers": 6,
    "maxPlayers": 10,
    "level": "Intermédiaire",
    "distance": "1.2km",
    "description": "Match amical entre amis...",
    "organizer": "Alex M.",
    "image": "https://...",
    "created_at": "2025-09-10T14:03:08.000Z"
  }
}
```

**Erreur (404 Not Found):**
```json
{
  "error": "Créneau introuvable"
}
```

**Erreur (500):**
```json
{
  "error": "Erreur lors de la récupération du créneau",
  "details": "Message d'erreur (en développement uniquement)"
}
```

---

## Architecture back-end

### Contrôleur : `lastminute.controller.js`

Le contrôleur centralise toute la logique métier :
- Validation des filtres
- Construction des requêtes SQL dynamiques
- Gestion des erreurs
- Promesses pour async/await

**Méthodes principales:**
- `getLastMinuteSlots(filters)` : Récupère les créneaux avec filtres
- `getSlotById(id)` : Récupère un créneau par ID

### Route : `lastminute.js`

La route utilise le contrôleur pour gérer les requêtes HTTP :
- Parsing des query params
- Appel au contrôleur
- Gestion des réponses et erreurs HTTP
- Logging des erreurs

---

## Améliorations implémentées

✅ **Séparation des responsabilités** : Route vs Contrôleur
✅ **Async/await** : Gestion moderne des opérations asynchrones
✅ **Gestion d'erreurs robuste** : Try/catch et codes HTTP appropriés
✅ **Tri par défaut** : Créneaux les plus récents en premier
✅ **Validation** : Filtres validés avant requête SQL
✅ **Sécurité** : Utilisation de requêtes paramétrées (protection SQL injection)
✅ **Logging** : console.error pour debug
✅ **Environnement** : Détails d'erreur uniquement en développement
