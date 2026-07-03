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
 * Persists a buffer under `${folder}/${filename}` and returns the public URL
 * (S3) or the /uploads-relative path (local disk).
 */
async function saveFile(buffer, folder, filename, mimetype) {
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

module.exports = { saveFile, usingS3: Boolean(s3) };
