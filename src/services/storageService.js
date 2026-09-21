/**
 * File storage abstraction.
 *
 * S3-compatible object storage (AWS S3, Cloudflare R2, Scaleway...) when
 * S3_BUCKET is configured; local disk under uploads/ otherwise. Local
 * disk is fine for a single instance but is lost on container redeploys
 * — configure S3_* in production (see docs/DEPLOY.md).
 *
 * Env: S3_BUCKET, S3_REGION, S3_ENDPOINT (optional, for R2/Scaleway),
 *      S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
 *      S3_PUBLIC_URL (base URL serving the bucket)
 */
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { logger } = require('../utils/logger');

const BUCKET = process.env.S3_BUCKET;
const PUBLIC_URL = (process.env.S3_PUBLIC_URL || '').replace(/\/$/, '');
const LOCAL_ROOT = path.join(__dirname, '../../uploads');

let s3 = null;
if (BUCKET) {
  const { S3Client } = require('@aws-sdk/client-s3');
  s3 = new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,
    credentials: process.env.S3_ACCESS_KEY_ID ? {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    } : undefined,
  });
  logger.info(`Storage: S3 bucket "${BUCKET}"`);
} else {
  logger.info('Storage: local disk (uploads/) — set S3_BUCKET for production');
}

/**
 * Recompression des images à l'upload.
 *
 * Une photo de téléphone pèse 3-5 Mo pour un rendu affiché à 800 px de large :
 * on paie la bande passante deux fois (à l'envoi, puis à chaque affichage).
 * On borne donc le grand côté et on ré-encode dans le même format — changer de
 * format changerait l'extension, donc l'URL déjà écrite en base.
 *
 * Le GIF est laissé intact (animation), et tout échec de sharp (fichier
 * corrompu, format exotique) renvoie l'original : un upload ne doit jamais
 * échouer à cause de l'optimisation.
 */
const MAX_DIMENSION = 1600;
const QUALITY = 80;

async function compressImage(buffer, mimetype) {
  if (!buffer || mimetype === 'image/gif') return buffer;
  if (!/^image\/(jpeg|png|webp)$/.test(String(mimetype))) return buffer;

  try {
    const pipeline = sharp(buffer).rotate().resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    });

    const out = mimetype === 'image/png'
      ? await pipeline.png({ compressionLevel: 9, palette: true }).toBuffer()
      : mimetype === 'image/webp'
        ? await pipeline.webp({ quality: QUALITY }).toBuffer()
        : await pipeline.jpeg({ quality: QUALITY, mozjpeg: true }).toBuffer();

    // Une image déjà optimisée peut grossir au ré-encodage : on garde la plus petite.
    return out.length < buffer.length ? out : buffer;
  } catch (e) {
    logger.warn(`Compression image ignorée (${mimetype}): ${e.message}`);
    return buffer;
  }
}

/**
 * Le type MIME d'un upload vient du client : on vérifie la signature binaire.
 * Sans ça, un exécutable ou du HTML renommé en .png passait le filtre multer.
 */
const SIGNATURES = {
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': (b) => b.length > 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')),
  'image/webp': (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'application/pdf': (b) => b.length > 5 && b.subarray(0, 5).toString('latin1') === '%PDF-',
};

function hasValidSignature(buffer, mimetype) {
  const check = SIGNATURES[String(mimetype)];
  return Boolean(check && Buffer.isBuffer(buffer) && check(buffer));
}

/**
 * Persists a buffer under `${folder}/${filename}` and returns the public URL
 * (S3) or the /uploads-relative path (local disk).
 * Les images sont recompressées au passage (voir `compressImage`).
 */
async function saveFile(rawBuffer, folder, filename, mimetype) {
  const buffer = await compressImage(rawBuffer, mimetype);
  const key = `${folder}/${filename}`;

  if (s3) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    return PUBLIC_URL ? `${PUBLIC_URL}/${key}` : `/${key}`;
  }

  const dir = path.join(LOCAL_ROOT, folder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, filename), buffer);
  return `/uploads/${key}`;
}

module.exports = { saveFile, compressImage, hasValidSignature, usingS3: Boolean(s3) };
