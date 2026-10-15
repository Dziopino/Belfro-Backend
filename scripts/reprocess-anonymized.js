/*
 * Przeliczenie starych plików zanonimizowanych z dzisiejszą logiką skalowania.
 *
 * Współrzędne zaznaczeń nie są przechowywane w bazie, a oryginały nigdy nie trafiają na dysk,
 * więc jedyny ślad to zamalowany prostokąt w zapisanym JPEG-u — to dokładnie dawne współrzędne
 * w pikselach CSS podglądu. Odtwarzamy go i mnożymy przez skalę podgląd -> oryginał.
 *
 * Rozpoznanie musi być pewne, bo fałszywy traf zamaluje część odpowiedzi. Kandydat to obszar
 * płaskiego 255/255/255 o twardych krawędziach, nie dotykający brzegu zdjęcia, o kształcie linijki
 * podpisu (szeroki, niski). Reszta plików dostaje status do ponownego przesłania.
 *
 * Plików źródłowych nie nadpisuje — zapisuje kopie obok, w anonymized_reprocessed.
 *
 *   node scripts/reprocess-anonymized.js [--probe] [--container-width=944] [--max-height=600] [--margin=0.12]
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const arg = (name, fallback) => {
  if (process.argv.includes(`--${name}`)) return true;
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};

const PROBE = arg('probe', false);
const CONTAINER_WIDTH = arg('container-width', 944);
const MAX_HEIGHT = arg('max-height', 600);
const MARGIN = arg('margin', 0.12);

const SRC_DIR = path.join(__dirname, '..', 'src', 'uploads', 'anonymized');
const OUT_DIR = path.join(__dirname, '..', 'src', 'uploads', 'anonymized_reprocessed');

const FLAT = 254;          // próg „czysta biel" maski
const MIN_AREA = 500;      // poniżej tego nie warto odpowiadać
const FLATNESS_MIN = 0.9;  // odsetek dokładnie 255 we wnętrzu
const FILL_MIN = 0.9;      // wypełnienie obszaru granicznego prostokąta
const SIGNATURE_MAX_CSS_WIDTH = 560;
const SIGNATURE_MAX_CSS_HEIGHT = 220;
const SIGNATURE_MIN_ASPECT = 1.4;

// Renderowana szerokość podglądu: min(naturalna, kontener, cap wysokości * proporcje)
function renderScale(width, height) {
  const renderedWidth = Math.min(width, CONTAINER_WIDTH, (MAX_HEIGHT * width) / height);
  return width / renderedWidth;
}

function whiteMask(data, width, height, channels) {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const p = i * channels;
    mask[i] = data[p] >= FLAT && data[p + 1] >= FLAT && data[p + 2] >= FLAT ? 1 : 0;
  }
  return mask;
}

function measure(data, channels, width, height, box) {
  let flat = 0;
  let total = 0;
  for (let y = box.y + 3; y < box.y + box.height - 3; y++) {
    for (let x = box.x + 3; x < box.x + box.width - 3; x++) {
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const p = (y * width + x) * channels;
      total++;
      if (data[p] === 255 && data[p + 1] === 255 && data[p + 2] === 255) flat++;
    }
  }
  return total > 0 ? flat / total : 0;
}

function components(mask, width, height, data, channels) {
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const out = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;

    let top = 0;
    stack[top++] = start;
    seen[start] = 1;

    let area = 0;
    let minX = width, maxX = -1, minY = height, maxY = -1;
    let touchesBorder = false;

    while (top > 0) {
      const idx = stack[--top];
      const x = idx % width;
      const y = (idx - x) / width;

      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;

      const neighbours = [
        x > 0 ? idx - 1 : -1,
        x < width - 1 ? idx + 1 : -1,
        y > 0 ? idx - width : -1,
        y < height - 1 ? idx + width : -1,
      ];
      for (const n of neighbours) {
        if (n >= 0 && mask[n] && !seen[n]) {
          seen[n] = 1;
          stack[top++] = n;
        }
      }
    }

    if (touchesBorder || area < MIN_AREA || area > width * height * 0.5) continue;

    const box = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
    const fill = area / (box.width * box.height);
    if (fill < FILL_MIN) continue;

    out.push({ ...box, area, fill, flatness: measure(data, channels, width, height, box) });
  }

  return out;
}

// kandydaci wyglądający jak zamalowana linijka z imieniem i nazwiskiem
function pickSignatureBox(cands, scale) {
  const ok = cands.filter((c) => {
    const cssWidth = c.width / scale;
    const cssHeight = c.height / scale;
    return cssWidth <= SIGNATURE_MAX_CSS_WIDTH &&
      cssHeight <= SIGNATURE_MAX_CSS_HEIGHT &&
      c.width / c.height >= SIGNATURE_MIN_ASPECT;
  });
  ok.sort((a, b) => b.flatness - a.flatness || b.fill - a.fill);
  return ok[0];
}

async function processFile(file) {
  const source = path.join(SRC_DIR, file);
  const meta = await sharp(source).metadata();
  const { data, info } = await sharp(source).raw().toBuffer({ resolveWithObject: true });
  const width = meta.width;
  const height = meta.height;

  const cands = components(whiteMask(data, width, height, info.channels), width, height, data, info.channels);
  const scale = renderScale(width, height);
  const old = pickSignatureBox(cands, scale);

  if (PROBE) {
    const top = [...cands].sort((a, b) => b.flatness - a.flatness).slice(0, 3);
    const line = top.map((c) => `${c.x},${c.y} ${c.width}x${c.height} pł=${(c.flatness * 100).toFixed(0)}% wyp=${(c.fill * 100).toFixed(0)}%`);
    return { file, status: 'probe', detail: `${width}x${height} ×${scale.toFixed(2)} | ${line.join(' | ') || 'brak'}`, accepted: Boolean(old) };
  }

  if (!old) return { file, status: 'nie_rozpoznano', detail: `${width}x${height} — ${(cands.length || 0)} kandydatów(biło), żaden nie wygląda na podpis` };

  const x = Math.max(0, Math.min(width - 1, Math.round(old.x * scale) - pad(old, scale, 'width')));
  const y = Math.max(0, Math.min(height - 1, Math.round(old.y * scale) - pad(old, scale, 'height')));
  const rectWidth = Math.max(1, Math.min(width - x, Math.round(old.width * scale) + pad(old, scale, 'width') * 2));
  const rectHeight = Math.max(1, Math.min(height - y, Math.round(old.height * scale) + pad(old, scale, 'height') * 2));

  const overlay = await sharp({
    create: { width: rectWidth, height: rectHeight, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer();

  await sharp(source)
    .composite([{ input: overlay, left: x, top: y }])
    .jpeg({ quality: 90 })
    .toFile(path.join(OUT_DIR, file));

  const washed = ((rectWidth * rectHeight) / (width * height)) * 100;
  return {
    file,
    status: 'przeliczono',
    scale: Number(scale.toFixed(2)),
    old: { x: old.x, y: old.y, width: old.width, height: old.height, flatness: Number(old.flatness.toFixed(3)) },
    rect: { x, y, width: rectWidth, height: rectHeight },
    washedPercent: Number(washed.toFixed(1)),
    detail: `${x},${y} ${rectWidth}x${rectHeight} (${washed.toFixed(1)}% kartki)`,
  };
}

function pad(box, scale, dim) {
  return Math.max(24, Math.round(box[dim] * scale * MARGIN));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = fs.readdirSync(SRC_DIR).filter((f) => /\.(jpg|jpeg|png)$/i.test(f));
  const results = [];

  for (const file of files) {
    const r = await processFile(file);
    results.push(r);
    console.log(`${file.slice(0, 22).padEnd(24)} ${String(r.status).padEnd(15)} ${r.detail ?? ''}`);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'reprocess-report.json'), JSON.stringify(results, null, 2));
  const done = results.filter((r) => r.status === 'przeliczono').length;
  const skipped = results.filter((r) => r.status === 'nie_rozpoznano').length;
  console.log(`\nPrzeliczono: ${done}/${files.length} · do ponownego przesłania: ${skipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
