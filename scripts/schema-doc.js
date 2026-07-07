/* Generates docs/SCHEMA.md from the live MySQL database. */
require('dotenv').config();
const fs = require('fs');
const mysql = require('mysql2');

const c = mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: process.env.DB_PORT,
});
const q = (sql, p = []) => new Promise((res, rej) => c.query(sql, p, (e, r) => (e ? rej(e) : res(r))));

const DOMAINS = [
  ['Utilisateurs & auth', ['users', 'user_profiles', 'password_resets', 'amis']],
  ['Clubs & terrains', ['clubs', 'club_images', 'club_opening_hours', 'club_payment_methods', 'club_socials', 'club_sports', 'clubs_stats', 'terrains', 'terrain_images', 'recurring_availabilities', 'availability_exceptions']],
  ['Créneaux & réservations', ['slots', 'reservations', 'reservation_participants', 'reservation_share_payments', 'payments']],
  ['Sessions sociales (annonces)', ['announcements', 'annonce_participants', 'annonce_invitations', 'annonce_waitlist', 'player_ratings']],
  ['Messagerie', ['chats', 'chat_participants', 'messages']],
  ['Divers', ['events', 'event_images', 'reviews', 'favorites', 'notifications', 'last_minute_slots', 'newsletter_subscribers', 'schema_migrations']],
];

(async () => {
  const cols = await q(`SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`);
  const fks = await q(`SELECT k.TABLE_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE, k.CONSTRAINT_NAME
    FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
    WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME, k.COLUMN_NAME`);
  // COLUMN_NAME is NULL for functional index parts — fall back to EXPRESSION.
  const idx = await q(`SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COALESCE(COLUMN_NAME, EXPRESSION) ORDER BY SEQ_IN_INDEX) AS COLS
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
    GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE ORDER BY TABLE_NAME, INDEX_NAME`);
  const checks = await q(`SELECT tc.TABLE_NAME, cc.CONSTRAINT_NAME, cc.CHECK_CLAUSE
    FROM information_schema.CHECK_CONSTRAINTS cc
    JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME AND tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
    WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.CONSTRAINT_TYPE = 'CHECK' ORDER BY tc.TABLE_NAME`);

  const byTable = (rows) => rows.reduce((m, r) => ((m[r.TABLE_NAME] = m[r.TABLE_NAME] || []).push(r), m), {});
  const colsBy = byTable(cols), fksBy = byTable(fks), idxBy = byTable(idx), chkBy = byTable(checks);
  const fkCols = new Set(fks.map(f => `${f.TABLE_NAME}.${f.COLUMN_NAME}`));

  const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/_utf8mb4/g, '').replace(/\\'/g, "'");
  const lastMigration = (await q('SELECT MAX(filename) f FROM schema_migrations'))[0].f || 'aucune';
  let md = `# Courtside — Schéma de base de données

> Généré depuis la base MySQL \`sport\` le ${new Date().toISOString().slice(0, 10)} (dernière migration : \`${lastMigration}\`).
> À régénérer après toute migration : voir \`courtside-back/src/migrations/\`.

Conventions :
- PK entières \`AUTO_INCREMENT\`. Parents historiques en \`BIGINT UNSIGNED\` (terrains, chats, announcements, reservations, slots…), \`users\`/\`clubs\` en \`INT\` — colonnes filles alignées sur le parent (migration 012).
- Toutes les relations portent une vraie FOREIGN KEY : \`CASCADE\` pour les lignes enfants pures, \`SET NULL\` pour l'historique qui survit au parent.
- La suppression de compte (RGPD) anonymise la ligne \`users\`, elle ne la supprime pas.
- Charset \`utf8mb4\`. Timestamps : mélange \`timestamp\`/\`datetime\` hérité (comportement identique pour l'app).
- Quirk hérité assumé : coordonnées nommées \`lat\`/\`lon\` sur \`clubs\` mais \`lat\`/\`lng\` sur \`announcements\` (précisions différentes aussi) — renommer casserait plus que ça ne rapporte.
- Base vierge : provisionnée d'un coup par \`src/migrations/baseline.sql\` (régénéré via \`npm run schema:baseline\`) ; bases existantes : migrations incrémentales.

`;

  for (const [domain, tables] of DOMAINS) {
    md += `\n## ${domain}\n`;
    for (const t of tables) {
      if (!colsBy[t]) continue;
      md += `\n### \`${t}\`\n\n`;
      md += `| Colonne | Type | Null | Défaut | Clé / Extra | Description |\n|---|---|---|---|---|---|\n`;
      for (const col of colsBy[t]) {
        const key = [
          col.COLUMN_KEY === 'PRI' ? 'PK' : col.COLUMN_KEY === 'UNI' ? 'UNIQUE' : col.COLUMN_KEY === 'MUL' ? 'INDEX' : '',
          fkCols.has(`${t}.${col.COLUMN_NAME}`) ? 'FK' : '',
          col.EXTRA.replace('DEFAULT_GENERATED', '').trim(),
        ].filter(Boolean).join(', ');
        const def = col.COLUMN_DEFAULT == null ? (col.IS_NULLABLE === 'YES' ? 'NULL' : '—') : esc(col.COLUMN_DEFAULT);
        md += `| \`${col.COLUMN_NAME}\` | \`${col.COLUMN_TYPE}\` | ${col.IS_NULLABLE === 'YES' ? 'oui' : 'non'} | ${def} | ${key} | ${esc(col.COLUMN_COMMENT)} |\n`;
      }
      const tfks = fksBy[t] || [];
      if (tfks.length) {
        md += `\n**Clés étrangères :**\n\n`;
        for (const f of tfks) md += `- \`${f.COLUMN_NAME}\` → \`${f.REFERENCED_TABLE_NAME}.${f.REFERENCED_COLUMN_NAME}\` (ON DELETE ${f.DELETE_RULE})\n`;
      }
      const tidx = (idxBy[t] || []).filter(i => i.INDEX_NAME !== 'PRIMARY');
      if (tidx.length) {
        md += `\n**Index :**\n\n`;
        for (const i of tidx) md += `- \`${i.INDEX_NAME}\`${i.NON_UNIQUE ? '' : ' (UNIQUE)'} : (${i.COLS.split(',').map(x => `\`${x}\``).join(', ')})\n`;
      }
      const tchk = chkBy[t] || [];
      if (tchk.length) {
        md += `\n**Contraintes CHECK :**\n\n`;
        for (const k of tchk) md += `- \`${k.CONSTRAINT_NAME}\` : \`${esc(k.CHECK_CLAUSE)}\`\n`;
      }
    }
  }

  fs.writeFileSync(process.argv[2], md);
  console.log('written', process.argv[2]);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
