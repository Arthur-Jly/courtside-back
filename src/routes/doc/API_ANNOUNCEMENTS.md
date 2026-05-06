# 📢 API Announcements - Documentation

API pour la gestion des annonces publiques et privées.

---

## 📋 Table des matières
- [Annonces publiques](#annonces-publiques)
- [Gestion des annonces](#gestion-des-annonces)
- [Invitations (annonces privées)](#invitations-annonces-privées)

---

## Annonces publiques

### GET `/api/announcements`
Récupère la liste des annonces publiques actives.

**Query Parameters:**
- `sport_type` (optionnel) - Filtrer par type de sport
- `status` (optionnel) - Filtrer par statut (`active`, `expired`, `cancelled`)

**Response 200:**
```json
{
  "announcements": [
    {
      "id": 1,
      "sport_type": "tennis",
      "terrain_id": 5,
      "slot_start": "2025-11-15T14:00:00Z",
      "slot_end": "2025-11-15T16:00:00Z",
      "places_total": 4,
      "places_disponibles": 2,
      "description": "Match de double débutant",
      "created_by": 10,
      "creator_name": "John Doe",
      "status": "active",
      "visibility": "public",
      "created_at": "2025-11-10T10:00:00Z",
      "terrain_name": "Court Central",
      "club_name": "Tennis Club Paris",
      "address": "123 Rue du Sport",
      "city": "Paris"
    }
  ],
  "count": 1
}
```

---

### GET `/api/announcements/:id`
Récupère une annonce spécifique avec ses participants.

**Headers:**
- `user-id` (optionnel) - ID de l'utilisateur pour vérifier l'accès aux annonces privées

**Response 200:**
```json
{
  "announcement": {
    "id": 1,
    "sport_type": "tennis",
    "terrain_id": 5,
    "slot_start": "2025-11-15T14:00:00Z",
    "slot_end": "2025-11-15T16:00:00Z",
    "places_total": 4,
    "places_disponibles": 2,
    "description": "Match de double débutant",
    "created_by": 10,
    "creator_name": "John Doe",
    "status": "active",
    "visibility": "public",
    "participants": [
      {
        "id": 1,
        "annonce_id": 1,
        "user_id": 10,
        "user_name": "John Doe",
        "user_email": "john@example.com",
        "role": "creator",
        "joined_at": "2025-11-10T10:00:00Z"
      },
      {
        "id": 2,
        "annonce_id": 1,
        "user_id": 15,
        "user_name": "Jane Smith",
        "user_email": "jane@example.com",
        "role": "participant",
        "joined_at": "2025-11-10T11:30:00Z"
      }
    ]
  }
}
```

**Response 403:**
```json
{
  "error": "Accès refusé à cette annonce privée"
}
```

**Response 404:**
```json
{
  "error": "Annonce introuvable"
}
```

---

## Gestion des annonces

### POST `/api/announcements`
Crée une nouvelle annonce (publique ou privée).

**Body:**
```json
{
  "sport_type": "tennis",
  "terrain_id": 5,
  "slot_start": "2025-11-15T14:00:00Z",
  "slot_end": "2025-11-15T16:00:00Z",
  "places_total": 4,
  "description": "Match de double débutant",
  "created_by": 10,
  "visibility": "public"
}
```

**Champs requis:**
- `sport_type` - Type de sport
- `slot_start` - Date et heure de début
- `slot_end` - Date et heure de fin
- `places_total` - Nombre total de places
- `created_by` - ID de l'utilisateur créateur

**Champs optionnels:**
- `terrain_id` - ID du terrain (nullable)
- `description` - Description de l'annonce
- `visibility` - `public` ou `private` (défaut: `public`)

**Response 201:**
```json
{
  "success": true,
  "announcement": {
    "id": 1,
    "sport_type": "tennis",
    "terrain_id": 5,
    "slot_start": "2025-11-15T14:00:00Z",
    "slot_end": "2025-11-15T16:00:00Z",
    "places_total": 4,
    "places_disponibles": 4,
    "description": "Match de double débutant",
    "created_by": 10,
    "status": "active",
    "visibility": "public",
    "participants": [...]
  }
}
```

**Response 400:**
```json
{
  "error": "Champs requis manquants"
}
```

---

### PUT `/api/announcements/:id`
Met à jour une annonce (seul le créateur peut modifier).

**Headers:**
- `user-id` (requis) - ID de l'utilisateur

**Body:**
```json
{
  "description": "Match de double niveau intermédiaire",
  "slot_start": "2025-11-15T15:00:00Z",
  "slot_end": "2025-11-15T17:00:00Z"
}
```

**Champs modifiables:**
- `description`
- `status` (`active`, `expired`, `cancelled`)
- `slot_start`
- `slot_end`

**Response 200:**
```json
{
  "success": true,
  "announcement": {...}
}
```

**Response 403:**
```json
{
  "error": "Seul le créateur peut modifier cette annonce"
}
```

---

### DELETE `/api/announcements/:id`
Annule une annonce (met le statut à `cancelled`).

**Headers:**
- `user-id` (requis) - ID de l'utilisateur

**Response 200:**
```json
{
  "success": true,
  "announcement": {...}
}
```

**Response 403:**
```json
{
  "error": "Seul le créateur peut modifier cette annonce"
}
```

---

### POST `/api/announcements/:id/join`
Rejoindre une annonce publique.

**Headers:**
- `user-id` (requis) - ID de l'utilisateur

**Response 200:**
```json
{
  "success": true,
  "participant": {
    "id": 2,
    "announcementId": 1,
    "userId": 15,
    "role": "participant"
  }
}
```

**Response 400:**
```json
{
  "error": "Plus de places disponibles"
}
```

**Response 409:**
```json
{
  "error": "Vous participez déjà à cette annonce"
}
```

---

### DELETE `/api/announcements/:id/leave`
Quitter une annonce.

**Headers:**
- `user-id` (requis) - ID de l'utilisateur

**Response 200:**
```json
{
  "success": true
}
```

**Response 403:**
```json
{
  "error": "Le créateur ne peut pas quitter son annonce"
}
```

**Response 404:**
```json
{
  "error": "Vous ne participez pas à cette annonce"
}
```

---

### GET `/api/users/:userId/announcements`
Récupère les annonces créées par un utilisateur.

**Response 200:**
```json
{
  "announcements": [...],
  "count": 5
}
```

---

## Invitations (annonces privées)

### POST `/api/announcements/:id/invite`
Inviter des amis à une annonce privée (seul le créateur peut inviter).

**Headers:**
- `user-id` (requis) - ID de l'utilisateur

**Body:**
```json
{
  "userIds": [12, 15, 18]
}
```

**Response 201:**
```json
{
  "success": true,
  "invitations": [
    {
      "id": 1,
      "annonce_id": 1,
      "user_id": 12,
      "invited_by": 10,
      "status": "pending"
    },
    {
      "id": 2,
      "annonce_id": 1,
      "user_id": 15,
      "invited_by": 10,
      "status": "pending"
    }
  ],
  "count": 2
}
```

**Response 400:**
```json
{
  "error": "Certains utilisateurs ne sont pas vos amis: 15, 18"
}
```

**Response 403:**
```json
{
  "error": "Les invitations ne sont possibles que pour les annonces privées"
}
```

---

### GET `/api/users/:userId/invitations`
Récupère les invitations d'un utilisateur.

**Query Parameters:**
- `status` (optionnel) - Filtrer par statut (`pending`, `accepted`, `declined`)

**Response 200:**
```json
{
  "invitations": [
    {
      "id": 1,
      "annonce_id": 1,
      "user_id": 12,
      "invited_by": 10,
      "inviter_name": "John Doe",
      "status": "pending",
      "invited_at": "2025-11-10T10:00:00Z",
      "sport_type": "tennis",
      "slot_start": "2025-11-15T14:00:00Z",
      "slot_end": "2025-11-15T16:00:00Z",
      "description": "Match entre amis",
      "places_disponibles": 2,
      "terrain_name": "Court Central",
      "club_name": "Tennis Club Paris",
      "address": "123 Rue du Sport",
      "city": "Paris"
    }
  ],
  "count": 1
}
```

---

### PUT `/api/invitations/:id/accept`
Accepter une invitation.

**Headers:**
- `user-id` (requis) - ID de l'utilisateur

**Response 200:**
```json
{
  "success": true,
  "invitation": {
    "id": 1,
    "annonce_id": 1,
    "user_id": 12,
    "invited_by": 10,
    "status": "pending"
  }
}
```

**Response 400:**
```json
{
  "error": "Plus de places disponibles"
}
```

**Response 404:**
```json
{
  "error": "Cette invitation a déjà été traitée"
}
```

---

### PUT `/api/invitations/:id/decline`
Refuser une invitation.

**Headers:**
- `user-id` (requis) - ID de l'utilisateur

**Response 200:**
```json
{
  "success": true
}
```

**Response 404:**
```json
{
  "error": "Invitation introuvable ou déjà traitée"
}
```

---

## 🔐 Notes de sécurité

- Les annonces privées ne sont visibles que par :
  - Le créateur
  - Les utilisateurs invités
  - Les participants
  
- Seul le créateur peut :
  - Modifier une annonce
  - Annuler une annonce
  - Inviter des amis à une annonce privée
  
- Les invitations ne peuvent être envoyées qu'à des amis (relation `amis` avec status `accepted`)

---

## 💡 Cas d'usage

### Créer une annonce publique
```bash
POST /api/announcements
{
  "sport_type": "tennis",
  "terrain_id": 5,
  "slot_start": "2025-11-15T14:00:00Z",
  "slot_end": "2025-11-15T16:00:00Z",
  "places_total": 4,
  "description": "Match de double débutant",
  "created_by": 10,
  "visibility": "public"
}
```

### Créer une annonce privée et inviter des amis
```bash
# 1. Créer l'annonce privée
POST /api/announcements
{
  "sport_type": "tennis",
  "slot_start": "2025-11-15T14:00:00Z",
  "slot_end": "2025-11-15T16:00:00Z",
  "places_total": 4,
  "created_by": 10,
  "visibility": "private"
}

# 2. Inviter des amis
POST /api/announcements/1/invite
Headers: user-id: 10
{
  "userIds": [12, 15, 18]
}
```

### Rejoindre une annonce publique
```bash
POST /api/announcements/1/join
Headers: user-id: 15
```

### Accepter une invitation
```bash
PUT /api/invitations/1/accept
Headers: user-id: 12
```
