# API - Profil de Club

Documentation des endpoints pour la gestion du profil complet d'un club.

---

## GET /api/clubs/:id/details

Récupère toutes les informations détaillées d'un club (infos de base + sports + images + horaires + réseaux sociaux + moyens de paiement).

### Paramètres URL
- `id` (number) - ID du club

### Réponse (200 OK)
```json
{
  "id": 1,
  "name": "Club Sportif Paris",
  "description": "Centre sportif moderne...",
  "address": "123 Avenue des Sports",
  "city": "Paris",
  "postal_code": "75015",
  "lat": 48.8566,
  "lon": 2.3522,
  "phone": "+33 1 23 45 67 89",
  "email": "contact@club.fr",
  "website": "www.club.fr",
  "rating": 4.5,
  "created_at": "2024-01-01T00:00:00.000Z",
  "sports": ["Padel", "Tennis", "Football"],
  "images": ["/uploads/clubs/image1.jpg", "/uploads/clubs/image2.jpg"],
  "openingHours": [
    {
      "id": 1,
      "club_id": 1,
      "day_of_week": 0,
      "open_time": "07:00:00",
      "close_time": "22:00:00",
      "is_closed": false
    }
  ],
  "socials": [
    {"type": "facebook", "url": "clubparis"},
    {"type": "instagram", "url": "@clubparis"}
  ],
  "paymentMethods": ["CB", "Stripe", "PayPal"]
}
```

### Erreurs
- `404` - Club introuvable
- `500` - Erreur serveur

---

## PUT /api/clubs/:id/info

Met à jour les informations de base d'un club.

### Paramètres URL
- `id` (number) - ID du club

### Body (JSON)
```json
{
  "name": "Nouveau nom",
  "description": "Nouvelle description",
  "address": "123 Rue Example",
  "city": "Paris",
  "postal_code": "75001",
  "phone": "+33 1 23 45 67 89",
  "email": "contact@example.fr",
  "website": "www.example.fr"
}
```

### Réponse (200 OK)
```json
{
  "message": "Informations mises à jour avec succès"
}
```

---

## PUT /api/clubs/:id/opening-hours

Met à jour les horaires d'ouverture d'un club.

### Paramètres URL
- `id` (number) - ID du club

### Body (JSON)
```json
{
  "hours": [
    {
      "day_of_week": 0,
      "open_time": "07:00",
      "close_time": "22:00",
      "is_closed": false
    },
    {
      "day_of_week": 1,
      "open_time": "07:00",
      "close_time": "22:00",
      "is_closed": false
    }
  ]
}
```

**Note:** `day_of_week` : 0 = Lundi, 6 = Dimanche

### Réponse (200 OK)
```json
{
  "message": "Horaires mis à jour avec succès"
}
```

---

## PUT /api/clubs/:id/socials

Met à jour les réseaux sociaux d'un club.

### Paramètres URL
- `id` (number) - ID du club

### Body (JSON)
```json
{
  "socials": [
    {"type": "facebook", "url": "monclub"},
    {"type": "instagram", "url": "@monclub"},
    {"type": "twitter", "url": "@monclub"}
  ]
}
```

### Réponse (200 OK)
```json
{
  "message": "Réseaux sociaux mis à jour avec succès"
}
```

---

## PUT /api/clubs/:id/payment-methods

Met à jour les moyens de paiement acceptés par un club.

### Paramètres URL
- `id` (number) - ID du club

### Body (JSON)
```json
{
  "methods": ["CB", "Espèces", "Stripe", "PayPal"]
}
```

### Réponse (200 OK)
```json
{
  "message": "Moyens de paiement mis à jour avec succès"
}
```

---

## Notes importantes

1. **Toutes les routes nécessitent l'ID du club** dans l'URL
2. **Les horaires** remplacent complètement les anciens horaires à chaque mise à jour
3. **Les réseaux sociaux** remplacent complètement les anciens réseaux à chaque mise à jour
4. **Les moyens de paiement** remplacent complètement les anciens moyens à chaque mise à jour
5. **Les sports** sont gérés via les routes existantes `/api/clubs/:id/sports`
