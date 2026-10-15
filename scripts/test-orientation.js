/*
 * Test: co robi obecny pipeline z kontrolera z JPEG-iem mającym EXIF Orientation=6
 * (zdjęcie z telefonu: piksele leżą w orientacji czujnika, przeglądarka obraca do pionu).
 *
 * Odtwarza kolejność operacji 1:1: sharp(buffer).composite(overlay).jpeg() -> sharp(buf).toFile()
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = path.join(__dirname, 'orientation-test');

// Obraz „z czujnika”: 600x1000, z czarnym markerem w rogu (0,0)-(200,60) = rzekome imię i nazwisko.
async function makeSensorJpeg(orientation) {
  const W = 600, H = 1000;
  const px = Buffer.alloc(W * H * 3, 200); // szare tło, żeby nie mylić z czystą bielą
  const put = (x, y, v) => { const i = (y * W + x) * 3; px[i] = px[i + 1] = px[i + 2] = v; };
  for (let y = 0; y < 60; y++) for (let x = 0; x < 200; x++) put(x, y, 10);

  return sharp(px, { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: 90 })
    .withMetadata({ orientation })
    .toBuffer();
}

function bboxOfDarkish(data, width, height, channels, pred) {
  let minX = width, minY = height, maxX = -1, maxY = -1, n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      if (pred(data[i], data[i + 1], data[i + 2])) {
        n++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return n ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, n } : null;
}

async function describe(label, file) {
  const meta = await sharp(file).metadata();
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const marker = bboxOfDarkish(data, info.width, info.height, info.channels, (r, g, b) => r < 60 && g < 60 && b < 60);
  const box = bboxOfDarkish(data, info.width, info.height, info.channels, (r, g, b) => r >= 253 && g >= 253 && b >= 253);
  console.log(
    `${label.padEnd(26)} ${info.width}x${info.height} exif=${meta.orientation ?? '-'}` +
    ` | marker=${marker ? `${marker.x},${marker.y} ${marker.width}x${marker.height}` : 'brak'}` +
    ` | biały=${box ? `${box.x},${box.y} ${box.width}x${box.height}` : 'brak'}`
  );
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // Użytkownik zaznacza marker na WYŚWIETLONYM (obróconym do pionu) obrazie 1000x600:
  // orientacja 6 = obrót o 90° zgodnie z ruchem wskazówek, więc róg czujnika (0,0)-(200,60)
  // wypada na ekranie po prawej u góry: x 940..999, y 0..199.
  const crop = { x: 935, y: 0, width: 70, height: 205 };

  const overlay = await sharp({
    create: { width: crop.width, height: crop.height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer();

  const buf = await makeSensorJpeg(6);
  await sharp(buf).toFile(path.join(OUT, '00-input.jpg'));
  await describe('wejście (telefon)', path.join(OUT, '00-input.jpg'));

  // 1) dokładnie jak w kontrolerze dziś
  const asIs = await sharp(buf)
    .composite([{ input: overlay, left: crop.x, top: crop.y }])
    .jpeg({ quality: 90 })
    .toBuffer();
  await sharp(asIs).toFile(path.join(OUT, '01-controller-current.jpg'));
  await describe('obecny pipeline', path.join(OUT, '01-controller-current.jpg'));

  // 2) .rotate() przed composite + drugi obieg tak jak w kontrolerze
  const withRotate = await sharp(buf)
    .rotate()
    .composite([{ input: overlay, left: crop.x, top: crop.y }])
    .jpeg({ quality: 90 })
    .toBuffer();
  await sharp(withRotate).toFile(path.join(OUT, '02-explicit-rotate.jpg'));
  await describe('rotate() + drugi obieg', path.join(OUT, '02-explicit-rotate.jpg'));

  // 3) bez żadnego obrotu, ale z odczytanym tagiem orientation w metadanych wyjścia
  await sharp(buf).toFile(path.join(OUT, '03-decode-only.jpg'));
  await describe('tylko przepisanie', path.join(OUT, '03-decode-only.jpg'));

  console.log(`\nPliki testowe: ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
