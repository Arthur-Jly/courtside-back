# Explo — solution email transactionnel gratuite

## TL;DR

**L'infra est déjà faite.** `src/services/emailService.js` utilise nodemailer en **SMTP générique** :
n'importe quel provider marche sans changer le code, il suffit de poser 4 variables d'env
(`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`) + `EMAIL_FROM`. Sans creds, les emails
sont loggés au lieu d'être envoyés (dev/CI OK).

Donc « choisir une solution » = choisir un compte SMTP + vérifier un domaine. Zéro refonte.

## Le vrai facteur bloquant : le domaine

Pour envoyer depuis `no-reply@courtside.fr` (ou autre), il faut :
- **posséder un nom de domaine** et pouvoir éditer ses DNS (ajouter SPF + DKIM, parfois DMARC).
- Sans domaine vérifié : soit on envoie depuis un sous-domaine sandbox du provider (`onboarding@resend.dev` etc.), OK pour tester mais pas pour de la prod crédible (les liens d'invitation/reset doivent atterrir en boîte de réception, pas en spam).

➡️ **Question n°1 avant tout** : est-ce qu'on a déjà un domaine `courtside.xx` acheté ? Si non, c'est le prérequis réel (≈ 5–12 €/an), plus déterminant que le choix du provider.

## Comparaison des free tiers (à jour ~2026, à revérifier au moment de créer le compte)

| Provider | Gratuit / mois | Limite jour | Domaine requis | CB requise | Notes |
|---|---|---|---|---|---|
| **Brevo** (ex-Sendinblue) | ~9 000 (300/j) | 300/j | Recommandé, pas obligatoire pour démarrer | Non | 🇫🇷 Français (RGPD, hébergement UE). Gros free tier. SMTP natif. |
| **Resend** | 3 000 | 100/j | Oui pour prod (sandbox `resend.dev` pour test) | Non | Le plus dev-friendly/moderne. SMTP + API. DX excellente. |
| **Mailjet** | 6 000 | 200/j | Recommandé | Non | 🇫🇷 Français aussi. SMTP natif. |
| **MailerSend** | 3 000 | — | Oui | Non | SMTP. Free tier réduit récemment. |
| **Amazon SES** | Payant (~0,10 $/1000) | — | Oui | Oui | Le moins cher à l'échelle, mais setup + mode sandbox au départ. Overkill maintenant. |
| **Postmark** | 100 (dev only) | — | Oui | Non | Deliverability top, mais free tier minuscule → paie vite. |
| **SendGrid** | variable (offre rabotée) | — | Oui | Parfois | Historiquement 100/j, offre gratuite devenue floue. Moins attractif. |

## Volume réel de Courtside

Emails = **transactionnel bas volume** : reset password, invitation gérant de club,
confirmation réservation, rappel J-1, welcome. À l'échelle actuelle on parle de
dizaines/jour, pas de milliers. **N'importe quel free tier suffit largement.**
Le critère n'est donc pas le volume mais : deliverability + facilité de vérif domaine + RGPD.

## Recommandation

**Brevo** ou **Resend**, selon la priorité :

- **Brevo** si tu veux le plus gros filet gratuit + société française (RGPD/UE, argument produit propre pour une app FR). SMTP direct, config en 5 min.
- **Resend** si tu veux la meilleure expérience dev et une vérif domaine ultra simple (DNS guidé, statut en temps réel). Free tier plus petit mais très au-dessus de nos besoins.

Ma préférence : **Resend** pour la simplicité de mise en route et la vérif domaine, sauf si
l'argument « données en UE / société FR » pèse pour toi → alors **Brevo**.

## Étapes concrètes une fois le provider choisi

1. Créer le compte (gratuit, sans CB).
2. Vérifier le domaine (ajouter les DNS SPF/DKIM fournis) — prérequis : posséder le domaine.
3. Générer des identifiants SMTP.
4. Poser dans `.env` de `courtside-back` : `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
   `EMAIL_FROM=Courtside <no-reply@ton-domaine>`, et `FRONTEND_URL` (déjà utilisé pour les liens).
5. Ajouter `sendClubInvitation(to, inviteUrl)` dans `emailService.js` (même pattern que
   `sendPasswordReset`) — c'est le seul bout de code à écrire pour le flow (b).
6. Test d'envoi réel (un email à toi-même) avant de brancher le flow admin.

## Décisions prises

- **Provider = Brevo** (ex-Sendinblue). Raisons : plus gros free tier (300/j = ~9 000/mois,
  soit 3× Resend), société française (données UE, RGPD propre pour une app FR), SMTP natif
  compatible avec l'`emailService.js` existant sans modif de code.
- **Domaine = PAS un blocage maintenant.** Il n'est requis que pour la prod « propre » plus tard.
  On construit et on teste tout sans domaine (voir les 3 niveaux ci-dessous).

## Le domaine n'est PAS obligatoire pour développer — 3 niveaux

| Niveau | Quand | Ce qu'il faut | Depuis quelle adresse |
|---|---|---|---|
| **1. Dev / build** | Maintenant | Rien du tout | Emails loggés (pas envoyés) — `emailService` dégrade déjà tout seul sans creds |
| **2. Test envoi réel** | Pour tester en vrai | Compte Brevo + « single sender » (vérifie 1 adresse Gmail perso) | Ton Gmail perso, vérifié en 1 clic. Pas de domaine, pas de DNS. Gratuit. |
| **3. Prod crédible** | À la mise en prod | Domaine acheté + DKIM/SPF dans Brevo | `no-reply@ton-domaine`. **1 seul changement d'env var**, zéro refonte. |

➡️ On code au **niveau 1**, on teste au **niveau 2** (Gmail via Brevo single sender), le **niveau 3
(domaine)** est repoussé à la mise en prod. Rien à acheter aujourd'hui.

## Prochaines étapes (dans l'ordre)

1. **(Maintenant)** Coder tout le flow avec `emailService` en mode log (niveau 1). Zéro compte requis.
2. **Ajouter `sendClubInvitation(to, inviteUrl)`** dans `emailService.js` (copie de
   `sendPasswordReset`). Seul bout de code à écrire pour le flow (b).
3. **(Pour tester en vrai — niveau 2)** Créer un compte Brevo gratuit → « single sender » avec ton
   Gmail → clé SMTP → poser dans `.env` : `SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=587`,
   `SMTP_USER` (login Brevo), `SMTP_PASS` (clé SMTP), `EMAIL_FROM=Courtside <ton-gmail>`.
4. **(Plus tard — niveau 3)** Acheter un domaine (OVH/Gandi/Cloudflare, ≈ 5–12 €/an), le vérifier
   dans Brevo (SPF/DKIM), et passer `EMAIL_FROM` sur `no-reply@ton-domaine`. Un seul env var change.

Le flow d'invitation gérant (option b) se construit dès l'étape 1 — le domaine n'y change rien.
