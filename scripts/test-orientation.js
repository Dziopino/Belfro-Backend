/*
 * Test: co robi obecny pipeline z kontrolera z JPEG-iem mającym EXIF Orientation=6
 * (zdjęcie z telefonu: piksele leżą w orientacji czujnika, przeglądarka obraca do pionu).
 *
 * Warianty 01-03 to historia błędu: bez `.rotate()` pikseli zostają w orientacji czujnika, a ramka
 * z podglądu trafia w inne miejsce. Wariant 04 to dzisiejszy kontroler razem z wzmocnieniem
 * widoczności pisma — on ma udowodnić, że wzmocnienie nie psuje tego, co naprawiło `.rotate()`:
 * wymiary, orientacja, kanał alfa i przede wszystkim biały prostokąt za imieniem i nazwiskiem.
 *
 * Uruchom: node scripts/test-orientation.js   (wariant 04 wymaga wcześniejszego `npm run build`)
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = path.join(__dirname, '..', 'tmp', 'orientation-test');

let enhanceAnonymizedScan;
try {
  enhanceAnonymizedScan = require('../dist/utils/scanEnhancement').enhanceAnonymizedScan;
} catch {
  console.error('Brak dist/utils/scanEnhancement.js — uruchom najpierw: npm run build');
  process.exit(1);
}

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
  let failures = 0;

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

  // 4) DZISIEJSZY KONTROLER + wzmocnienie: rotate → composite → PNG → enhanceAnonymizedScan → bajty.
  //    Ramka po obrocie to 1000x600, prostokąt przycinamy dokładnie tak jak w kontrolerze.
  const frameWidth = 1000;
  const frameHeight = 600;
  const redactionX = Math.max(0, crop.x);
  const redactionY = Math.max(0, crop.y);
  const redactionWidth = Math.min(crop.x + crop.width, frameWidth) - redactionX;
  const redactionHeight = Math.min(crop.y + crop.height, frameHeight) - redactionY;

  const masked = await sharp(buf)
    .rotate()
    .composite([{ input: overlay, left: crop.x, top: crop.y }])
    .png()
    .toBuffer();

  const enhanced = await enhanceAnonymizedScan(
    masked,
    { width: frameWidth, height: frameHeight },
    undefined,
    { x: redactionX, y: redactionY, width: redactionWidth, height: redactionHeight }
  );
  const outFile = path.join(OUT, '04-controller-with-enhancement.jpg');
  await fs.promises.writeFile(outFile, enhanced);
  await describe('kontroler + wzmocnienie', outFile);

  const plainOfSameFrame = await sharp(masked).jpeg({ quality: 90 }).toBuffer();

  const outMeta = await sharp(enhanced).metadata();
  const { data: outData, info: outInfo } = await sharp(enhanced).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = outInfo.channels;

  const inside = (x, y) =>
    x >= redactionX && x < redactionX + redactionWidth && y >= redactionY && y < redactionY + redactionHeight;

  let maskMin = 255;
  for (let y = redactionY + 6; y < redactionY + redactionHeight - 6; y++) {
    for (let x = redactionX + 6; x < redactionX + redactionWidth - 6; x++) {
      const i = (y * outInfo.width + x) * ch;
      maskMin = Math.min(maskMin, outData[i], outData[i + 1], outData[i + 2]);
    }
  }

  let markerOutside = 0;
  for (let y = 0; y < outInfo.height; y++) {
    for (let x = 0; x < outInfo.width; x++) {
      if (inside(x, y)) continue;
      const i = (y * outInfo.width + x) * ch;
      if (outData[i] < 60 && outData[i + 1] < 60 && outData[i + 2] < 60) markerOutside++;
    }
  }

  // Obszar rzekomego imienia i nazwiska w RAMCE PO OBROCIE, wyznaczony na obrazie bez maski.
  // Bez tego asercja poniżej byłaby o niczym: marker leży w całości pod prostokątem, więc
  // „ciemnych pikseli poza prostokątem = 0" nie dowodzi, że cokolwiek zamalowaliśmy.
  const { data: nakedData, info: nakedInfo } = await sharp(buf).rotate().removeAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  let nameBox = null;
  {
    let minX = nakedInfo.width, minY = nakedInfo.height, maxX = -1, maxY = -1;
    for (let y = 0; y < nakedInfo.height; y++) {
      for (let x = 0; x < nakedInfo.width; x++) {
        const i = (y * nakedInfo.width + x) * nakedInfo.channels;
        if (nakedData[i] < 60 && nakedData[i + 1] < 60 && nakedData[i + 2] < 60) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
      }
    }
    if (maxX >= 0) nameBox = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  let nameMin = 255;
  if (nameBox) {
    for (let y = nameBox.y; y < nameBox.y + nameBox.height; y++) {
      for (let x = nameBox.x; x < nameBox.x + nameBox.width; x++) {
        const i = (y * outInfo.width + x) * ch;
        nameMin = Math.min(nameMin, outData[i], outData[i + 1], outData[i + 2]);
      }
    }
  }

  const expect = (label, ok, detail) => {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
    if (!ok) failures += 1;
  };

  console.log('\n== Asercje wariantu 04');
  expect('wymiary wejście = wyjście (1000x600)', outInfo.width === frameWidth && outInfo.height === frameHeight,
    `${outInfo.width}x${outInfo.height}`);
  expect('wnętrze maski (margines 6 px) ≥ 253 we wszystkich kanałach', maskMin >= 253, `min=${maskMin}`);
  expect('markera („imię i nazwisko") nie ma poza prostokątem', markerOutside === 0, `pikseli=${markerOutside}`);
  expect(
    `cały obszar nazwiska (${nameBox ? `${nameBox.x},${nameBox.y} ${nameBox.width}x${nameBox.height}` : 'brak'}) ≥ 253`,
    nameBox !== null && nameMin >= 253,
    `min=${nameMin}`
  );
  expect('brak kanału alfa w metadanych', outMeta.hasAlpha === false, `hasAlpha=${String(outMeta.hasAlpha)}`);
  expect('brak orientacji EXIF w metadanych', outMeta.orientation === undefined,
    `orientation=${String(outMeta.orientation)}`);
  expect('waga w rozsądnym przedziale względem JPEG-a tej samej ramki',
    enhanced.length > plainOfSameFrame.length * 0.3 && enhanced.length < plainOfSameFrame.length * 4,
    `${(plainOfSameFrame.length / 1024).toFixed(0)} kB -> ${(enhanced.length / 1024).toFixed(0)} kB`);

  console.log(`\nPliki testowe: ${OUT}`);
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
