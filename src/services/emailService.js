/**
 * Transactional email service.
 *
 * Uses SMTP when SMTP_HOST is configured (any provider: Resend, Brevo,
 * Postmark, Mailgun... all expose SMTP). Without SMTP_HOST the service
 * degrades gracefully: emails are logged instead of sent, so dev and CI
 * work without credentials.
 *
 * Env: SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS,
 *      EMAIL_FROM (default "Courtside <no-reply@courtside.fr>")
 */
const nodemailer = require('nodemailer');
const { logger } = require('../utils/logger');

const FROM = process.env.EMAIL_FROM || 'Courtside <no-reply@courtside.fr>';

let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  logger.info('Email service: SMTP configured');
} else {
  logger.warn('Email service: SMTP_HOST not set — emails will be logged, not sent');
}

/** Base layout matching the Courtside design tokens. */
function layout(title, bodyHtml) {
  return `<!doctype html>
<html lang="fr">
<body style="margin:0;padding:0;background:#F7F4EE;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#0F1A18;">
  <div style="max-width:520px;margin:0 auto;padding:32px 20px;">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:24px;">
      <div style="width:32px;height:32px;border-radius:8px;background:#0F1A18;color:#C8F25C;text-align:center;line-height:32px;font-size:20px;font-family:Georgia,serif;">c</div>
      <span style="font-size:18px;font-weight:600;">Courtside</span>
    </div>
    <div style="background:#FFFFFF;border:1px solid #E3DCCE;border-radius:16px;padding:28px;">
      <h1 style="margin:0 0 14px;font-size:22px;font-weight:600;">${title}</h1>
      ${bodyHtml}
    </div>
    <p style="font-size:12px;color:#6E7A77;margin-top:18px;text-align:center;">
      Courtside — réservez un terrain en deux clics.<br>
      Vous recevez cet email parce qu'un compte Courtside utilise cette adresse.
    </p>
  </div>
</body>
</html>`;
}

function button(href, label) {
  return `<a href="${href}" style="display:inline-block;background:#1F3A33;color:#F7F4EE;text-decoration:none;padding:12px 22px;border-radius:999px;font-size:14px;font-weight:600;margin:12px 0;">${label}</a>`;
}

async function send(to, subject, html) {
  if (!transporter) {
    logger.info(`[email:dev] to=${to} subject="${subject}"`);
    logger.debug(html);
    return { sent: false, logged: true };
  }
  await transporter.sendMail({ from: FROM, to, subject, html });
  logger.info(`Email sent to=${to} subject="${subject}"`);
  return { sent: true };
}

async function sendPasswordReset(to, resetUrl) {
  const html = layout('Réinitialiser votre mot de passe', `
    <p style="font-size:14px;line-height:1.6;color:#364541;">
      Vous avez demandé à réinitialiser votre mot de passe Courtside.
      Ce lien est valable <strong>1 heure</strong>.
    </p>
    ${button(resetUrl, 'Choisir un nouveau mot de passe')}
    <p style="font-size:13px;line-height:1.6;color:#6E7A77;">
      Si vous n'êtes pas à l'origine de cette demande, ignorez cet email —
      votre mot de passe actuel reste valable.
    </p>
  `);
  return send(to, 'Réinitialisation de votre mot de passe Courtside', html);
}

async function sendWelcome(to, name) {
  const html = layout(`Bienvenue ${name} !`, `
    <p style="font-size:14px;line-height:1.6;color:#364541;">
      Votre compte Courtside est prêt. Trouvez un terrain, rejoignez des
      matchs près de chez vous et organisez vos sessions avec vos amis.
    </p>
    ${button(process.env.FRONTEND_URL || 'http://localhost:5173', 'Trouver un terrain')}
  `);
  return send(to, 'Bienvenue sur Courtside', html);
}

module.exports = { send, sendPasswordReset, sendWelcome, layout, button };
