const { test } = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');

const { compressImage } = require('../src/services/storageService');

/** Photo bruitée : une image unie se compresse trop bien pour être un test honnête. */
async function bigJpeg(width, height) {
  const px = Buffer.alloc(width * height * 3);
  for (let i = 0; i < px.length; i++) px[i] = (i * 2654435761) % 256;
  return sharp(px, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
}

test('BK-INF-08 compressImage borne le grand côté à 1600 px', async () => {
  const original = await bigJpeg(2400, 1200);
  const out = await compressImage(original, 'image/jpeg');

  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 1600);
  assert.equal(meta.height, 800);
  assert.ok(out.length < original.length, 'le fichier doit rétrécir');
});

test('BK-INF-08 une image déjà petite n\'est jamais agrandie', async () => {
  const original = await bigJpeg(320, 240);
  const out = await compressImage(original, 'image/jpeg');

  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 320);
  assert.equal(meta.height, 240);
  assert.ok(out.length <= original.length, 'jamais plus lourd que l\'original');
});

test('BK-INF-08 le GIF et les types inconnus passent intacts', async () => {
  const gif = Buffer.from('GIF89a-not-really-a-gif');
  assert.equal(await compressImage(gif, 'image/gif'), gif);

  const pdf = Buffer.from('%PDF-1.4');
  assert.equal(await compressImage(pdf, 'application/pdf'), pdf);
});

test('BK-INF-08 un buffer illisible ressort tel quel (l\'upload ne casse pas)', async () => {
  const junk = Buffer.from('pas une image du tout');
  const out = await compressImage(junk, 'image/jpeg');
  assert.equal(out, junk);
});
