-- Abonnements Web Push (phase 1).
--
-- Une partie publiée le matin pour le soir ne se remplit pas sans notification
-- poussée : le SSE ne vit que le temps d'un onglet ouvert. C'est la condition
-- pratique du modèle « fenêtre courte » de la phase 1.
--
-- Un abonnement appartient à un couple (utilisateur, appareil) : l'endpoint est
-- unique, et un même utilisateur peut en avoir plusieurs.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              INT NOT NULL AUTO_INCREMENT,
  user_id         INT NOT NULL,
  endpoint        VARCHAR(500) NOT NULL,
  p256dh          VARCHAR(255) NOT NULL,
  auth            VARCHAR(255) NOT NULL,
  user_agent      VARCHAR(255) DEFAULT NULL,
  failure_count   INT NOT NULL DEFAULT 0,
  last_success_at DATETIME DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_push_endpoint (endpoint),
  KEY idx_push_user (user_id),
  CONSTRAINT fk_push_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
