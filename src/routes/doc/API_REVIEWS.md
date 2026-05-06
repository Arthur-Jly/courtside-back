# API REVIEWS - Documentation

## 📋 Routes disponibles

### 1. Récupérer tous les commentaires d'un club
```
GET /api/reviews/clubs/:clubId
```

**Réponse :**
```json
[
  {
    "id": 1,
    "user_id": 1,
    "club_id": 1,
    "rating": 5,
    "comment": "Excellent club !",
    "response": "Merci beaucoup !",
    "created_at": "2025-10-15T14:30:00.000Z",
    "user_name": "Jean Dupont",
    "user_avatar": "https://..."
  }
]
```

---

### 2. Récupérer un commentaire spécifique
```
GET /api/reviews/:id
```

**Réponse :**
```json
{
  "id": 1,
  "user_id": 1,
  "club_id": 1,
  "rating": 5,
  "comment": "Excellent club !",
  "response": "Merci beaucoup !",
  "created_at": "2025-10-15T14:30:00.000Z",
  "user_name": "Jean Dupont",
  "user_avatar": "https://..."
}
```

---

### 3. Créer un nouveau commentaire
```
POST /api/reviews
Content-Type: application/json

{
  "user_id": 1,
  "club_id": 1,
  "rating": 5,
  "comment": "Super club !"
}
```

**Validation :**
- `user_id` : requis
- `club_id` : requis
- `rating` : requis (entre 1 et 5)
- `comment` : requis

**Réponse :**
```json
{
  "success": true,
  "id": 42,
  "message": "Avis créé avec succès"
}
```

---

### 4. Modifier un commentaire
```
PUT /api/reviews/:id
Content-Type: application/json

{
  "rating": 4,
  "comment": "Très bon club finalement !"
}
```

**Champs optionnels :**
- `rating` : entre 1 et 5
- `comment` : texte

**Réponse :**
```json
{
  "success": true,
  "message": "Avis modifié avec succès"
}
```

---

### 5. Ajouter/Modifier une réponse (admin club)
```
PUT /api/reviews/:id/response
Content-Type: application/json

{
  "response": "Merci pour votre retour !"
}
```

**Réponse :**
```json
{
  "success": true,
  "message": "Réponse ajoutée avec succès"
}
```

---

### 6. Supprimer un commentaire
```
DELETE /api/reviews/:id
```

**Réponse :**
```json
{
  "success": true,
  "message": "Avis supprimé avec succès"
}
```

---

### 7. Récupérer tous les commentaires d'un utilisateur
```
GET /api/reviews/users/:userId
```

**Réponse :**
```json
[
  {
    "id": 1,
    "user_id": 1,
    "club_id": 1,
    "rating": 5,
    "comment": "Excellent club !",
    "response": "Merci beaucoup !",
    "created_at": "2025-10-15T14:30:00.000Z",
    "club_name": "Tennis Club Paris",
    "club_city": "Paris"
  }
]
```

---

### 8. Statistiques des avis d'un club
```
GET /api/reviews/clubs/:clubId/stats
```

**Réponse :**
```json
{
  "total_reviews": 25,
  "average_rating": 4.2,
  "five_stars": 10,
  "four_stars": 8,
  "three_stars": 5,
  "two_stars": 1,
  "one_star": 1
}
```

---

## 🔧 Installation

1. **Créer le fichier de routes :**
   - `back/src/routes/reviews.js` ✅

2. **Enregistrer dans index.js :**
   ```javascript
   const reviewsRouter = require('./routes/reviews')(db);
   app.use('/api', reviewsRouter);
   ```

3. **Ajouter la colonne response :**
   ```sql
   ALTER TABLE reviews 
   ADD COLUMN response TEXT NULL 
   AFTER comment;
   ```

4. **Insérer les données de test :**
   ```bash
   mysql -u root -p sport < back/sql/mock_reviews.sql
   ```

5. **Redémarrer le serveur :**
   ```bash
   node src/index.js
   ```

---

## 🧪 Tests

### Test 1 : Récupérer les avis d'un club
```bash
curl http://localhost:3001/api/reviews/clubs/1
```

### Test 2 : Créer un avis
```bash
curl -X POST http://localhost:3001/api/reviews \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": 1,
    "club_id": 1,
    "rating": 5,
    "comment": "Super club !"
  }'
```

### Test 3 : Ajouter une réponse
```bash
curl -X PUT http://localhost:3001/api/reviews/1/response \
  -H "Content-Type: application/json" \
  -d '{
    "response": "Merci pour votre avis !"
  }'
```

### Test 4 : Statistiques d'un club
```bash
curl http://localhost:3001/api/reviews/clubs/1/stats
```

---

## 📊 Données de test

Le fichier `mock_reviews.sql` contient :
- **30+ commentaires** répartis sur 5 clubs
- Mélange de notes (1 à 5 étoiles)
- Certains avec réponses, d'autres sans
- Variété de commentaires positifs et négatifs
- Dates réalistes (derniers mois)

---

## 🔐 Sécurité (à implémenter plus tard)

- [ ] Authentification JWT pour créer/modifier/supprimer
- [ ] Vérifier que l'utilisateur peut uniquement modifier ses propres avis
- [ ] Vérifier que seul l'admin du club peut répondre aux avis
- [ ] Rate limiting pour éviter le spam
- [ ] Validation XSS sur les commentaires

---

## 📝 Notes

- Les avis sont triés par date (plus récents en premier)
- La note moyenne est calculée automatiquement
- Les statistiques incluent la répartition par étoiles
- Les commentaires incluent le nom et l'avatar de l'utilisateur

