/*
 * Pomiar i asercje wzmocnienia skanu PO zamazaniu imienia. Czysto lokalnie: bez bazy, bez sieci,
 * bez wywołania modelu i bez płatnego `/process`. Uruchom:
 *   npx ts-node --transpile-only scripts/test-scan-enhancement.ts
 *
 * Dwie części. Pierwsza buduje syntetyk z trzema siłami cienia papieru, atramentem i ołówkiem;
 * klasy pikseli znamy z konstrukcji, a nie z progowania — tylko tak da się uczciwie odpowiedzieć
 * na pytanie „czy wzmocnienie nie zabrało ołówka". Druga powtarza pomiar na prawdziwym zamazanym
 * skanie z `uploads/anonymized/` (odczyt dozwolony); tam klasy wyznacza stały próg Otsu policzony
 * NA ORYGINALE i ta sama maska porządkuje obie wersje, żeby „kontrast pisma" nie był porównaniem
 * dwóch różnych podziałów obrazu.
 *
 * Wiersz „ZAKAZANY pipeline" w tabelce to kolejność zapisana w pierwotnej instrukcji
 * (normalize na percentylach → gamma → linear → sharpen). Świadomie jej nie usunęliśmy z pomiaru:
 * liczby poniżej są dowodem, dlaczego ten moduł jej nie stosuje.
 *
 * Pliki pomiarowe idą wyłącznie pod `backend/tmp/` i są kasane na końcu — kontrakt §1.
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { ANONYMIZED_DIR } from '../src/config/paths';
import { DEFAULT_SCAN_ENHANCE, enhanceAnonymizedScan, type ScanEnhanceParams } from '../src/utils/scanEnhancement';

const TMP = path.join(__dirname, '..', 'tmp');

/** Klasy pikseli syntetyku: 0 papier w świetle, 1 papier w cieniu, 2 atrament, 3 ołówek, 4 maska. */
type ClassId = 0 | 1 | 2 | 3 | 4;

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`OK   ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

interface Pixels {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
}

async function toPixels(input: Buffer): Promise<Pixels> {
  const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, channels: info.channels, data };
}

function grey(px: Pixels, x: number, y: number): number {
  const i = (y * px.width + x) * px.channels;
  return 0.299 * px.data[i] + 0.587 * px.data[i + 1] + 0.114 * px.data[i + 2];
}

/** Najmniejsza wartość któregokolwiek kanału w prostokącie — to pilnuje maski danych osobowych. */
function minOfRegion(px: Pixels, x0: number, y0: number, w: number, h: number): number {
  let min = 255;

  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * px.width + x) * px.channels;
      min = Math.min(min, px.data[i], px.data[i + 1], px.data[i + 2]);
    }
  }

  return min;
}

interface Stats {
  mean: number;
  sd: number;
  count: number;
}

function statsOf(values: number[]): Stats {
  if (!values.length) return { mean: NaN, sd: NaN, count: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  return { mean, sd, count: values.length };
}

// Maska leży w prawym górnym rogu syntetyku; pomiar wnętrza z marginesem 4 px, bo granica
// białego prostokąta i tak ciemnieje od pierścienia JPEG-a i `sharpen` (patrz asercja niżej).
const MASK = { x: 700, y: 60, width: 130, height: 44 };

/**
 * Syntetyk „kartka sfotografowana telefonem": 900x1300, papier od 236 w lewej górze, `depth`
 * skali ciemnienia ku prawemu dołowi, atrament 58, ołówek 152, biała maska 130x44. Tablica klas
 * powstaje razem z pikselami, więc pomiar niczego nie zgaduje.
 */
function buildSynthetic(depth: number): { raw: Buffer; classes: Uint8Array; width: number; height: number } {
  const width = 900;
  const height = 1300;
  const classes = new Uint8Array(width * height);
  const raw = Buffer.alloc(width * height * 3);

  const put = (x: number, y: number, value: number, cls: ClassId): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 3;
    raw[i] = raw[i + 1] = raw[i + 2] = value;
    classes[y * width + x] = cls;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const shadow = 236 - depth * (x / width) ** 1.2 - depth * 0.32 * (y / height);
      const noise = ((x * 31 + y * 17) % 7) - 3;
      const value = Math.round(Math.max(150, Math.min(245, shadow + noise)));
      put(x, y, value, x / width > 0.55 ? 1 : 0);
    }
  }

  const stroke = (x0: number, y0: number, len: number, thick: number, value: number, cls: ClassId): void => {
    for (let dy = 0; dy < thick; dy++) {
      for (let dx = 0; dx < len; dx++) put(x0 + dx, y0 + dy, value, cls);
    }
  };

  for (let line = 0; line < 6; line++) {
    const y = 220 + line * 90;
    for (let w = 0; w < 7; w++) {
      stroke(80 + w * 100, y, 62, 3, 58, 2);
      stroke(80 + w * 100, y + 22, 44, 2, 58, 2);
    }
    // Ołówek: podkreślenia i poprawki. To one giną pierwsze przy binaryzacji i muszą przeżyć.
    stroke(80, y + 46, 320, 2, 152, 3);
  }

  for (let y = MASK.y; y < MASK.y + MASK.height; y++) {
    for (let x = MASK.x; x < MASK.x + MASK.width; x++) put(x, y, 255, 4);
  }

  return { raw, classes, width, height };
}

function measure(px: Pixels, classes: Uint8Array, width: number, height: number) {
  const buckets: number[][] = [[], [], [], [], []];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      buckets[classes[y * width + x]].push(grey(px, x, y));
    }
  }

  const paper = statsOf([...buckets[0], ...buckets[1]]);
  const ink = statsOf(buckets[2]);
  const pencil = statsOf(buckets[3]);

  return {
    paper,
    ink,
    pencil,
    mask: statsOf(buckets[4]),
    contrast: paper.mean - ink.mean,
    pencilSep: paper.mean - pencil.mean,
  };
}

type SyntheticMeasure = ReturnType<typeof measure>;

function row(label: string, m: SyntheticMeasure, bytes?: number): string {
  return (
    `${label.padEnd(22)} tło=${m.paper.mean.toFixed(1)} nierównom=${m.paper.sd.toFixed(1)} ` +
    `atrament=${m.ink.mean.toFixed(1)} ołówek=${m.pencil.mean.toFixed(1)} ` +
    `kontrast=${m.contrast.toFixed(1)} oł.-sep=${m.pencilSep.toFixed(1)}` +
    (bytes === undefined ? '' : ` waga=${(bytes / 1024).toFixed(0)}kB`)
  );
}

/** Kolejność z pierwotnej instrukcji — zostawiona wyłącznie jako dowód pomiarowy. */
async function forbiddenPipeline(masked: Buffer): Promise<Buffer> {
  return sharp(masked)
    .normalize({ lower: 1, upper: 99 })
    .gamma(1.2)
    .linear(1.3, -15)
    .sharpen({ sigma: 0.8 })
    .jpeg({ quality: DEFAULT_SCAN_ENHANCE.jpegQuality })
    .toBuffer();
}

/** Próg Otsu na 8-bitowym histogramie jasności. Liczony na oryginale i użyty do obu wersji. */
function otsuThreshold(px: Pixels): number {
  const hist = new Array<number>(256).fill(0);
  const total = px.width * px.height;

  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) hist[Math.round(grey(px, x, y))]++;
  }

  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0;
  let wB = 0;
  let best = -1;
  let threshold = 127;

  for (let i = 0; i < 256; i++) {
    sumB += i * hist[i];
    wB += hist[i];
    if (wB === 0 || wB === total) continue;
    const wF = total - wB;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = i;
    }
  }

  return threshold;
}

function measureReal(px: Pixels, threshold: number) {
  const paper: number[] = [];
  const ink: number[] = [];

  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      const g = grey(px, x, y);
      if (g <= threshold) ink.push(g);
      else paper.push(g);
    }
  }

  const paperStats = statsOf(paper);
  const inkStats = statsOf(ink);

  return {
    paper: paperStats,
    ink: inkStats,
    contrast: paperStats.mean - inkStats.mean,
    paperShare: paper.length / (px.width * px.height),
  };
}

type RealMeasure = ReturnType<typeof measureReal>;

/** Pierwszy odkodowalny plik z `uploads/anonymized`; nazwy nie logujemy, bo niesie uuid ucznia. */
async function pickRealScan(): Promise<Buffer | null> {
  if (!fs.existsSync(ANONYMIZED_DIR)) return null;

  const names = fs.readdirSync(ANONYMIZED_DIR).filter((n) => n.toLowerCase().endsWith('.jpg'));

  for (const name of names) {
    try {
      const file = await fs.promises.readFile(path.join(ANONYMIZED_DIR, name));
      const meta = await sharp(file).metadata();
      if (meta.width && meta.height) return file;
    } catch {
      // Plik uszkodzony albo nie jest obrazem — przechodzimy do następnego.
    }
  }

  return null;
}

async function pngOf(synth: { raw: Buffer; width: number; height: number }): Promise<Buffer> {
  return sharp(synth.raw, { raw: { width: synth.width, height: synth.height, channels: 3 } })
    .png()
    .toBuffer();
}

async function main(): Promise<void> {
  fs.mkdirSync(TMP, { recursive: true });

  // ------------------------------------------------------------------ tabelka porównawcza
  console.log('== Porównanie wariantów na syntetyku (głębokość cienia 90 = najtrudniejszy kadr)');
  const hard = buildSynthetic(90);
  const hardPng = await pngOf(hard);
  const hardPx = await toPixels(hardPng);
  const hardClasses = hard.classes;
  console.log(row('WEJŚCIE', measure(hardPx, hardClasses, hard.width, hard.height), hardPng.length));

  const candidates: Array<{ name: string; params: ScanEnhanceParams }> = [
    { name: 'wybrane', params: DEFAULT_SCAN_ENHANCE },
    { name: 'bez flat-fieldu', params: { ...DEFAULT_SCAN_ENHANCE, maxGain: 1 } },
    { name: 'percentyla 95', params: { ...DEFAULT_SCAN_ENHANCE, fieldPercentile: 95 } },
    { name: 'zysk do 2.0', params: { ...DEFAULT_SCAN_ENHANCE, maxGain: 2 } },
    { name: 'affine 1.30/-15', params: { ...DEFAULT_SCAN_ENHANCE, linearA: 1.3, linearB: -15 } },
    { name: 'affine 1.40/-25', params: { ...DEFAULT_SCAN_ENHANCE, linearA: 1.4, linearB: -25 } },
    { name: 'bez sharpen', params: { ...DEFAULT_SCAN_ENHANCE, sharpenSigma: 0.05 } },
    { name: 'bez linear', params: { ...DEFAULT_SCAN_ENHANCE, linearA: 1, linearB: 0 } },
  ];

  for (const c of candidates) {
    const out = await enhanceAnonymizedScan(hardPng, { width: hard.width, height: hard.height }, c.params, MASK);
    const px = await toPixels(out);
    console.log(row(c.name, measure(px, hardClasses, hard.width, hard.height), out.length));
  }

  console.log(row('ZAKAZANY pipeline', measure(await toPixels(await forbiddenPipeline(hardPng)), hardClasses, hard.width, hard.height)));

  // ------------------------------------------------------------------ asercje na trzech cieniach
  console.log('\n== Asercje: trzy siły cienia');
  const depths = [8, 40, 90];

  for (const depth of depths) {
    const synth = buildSynthetic(depth);
    const png = await pngOf(synth);
    const beforePx = await toPixels(png);
    const mBefore = measure(beforePx, synth.classes, synth.width, synth.height);

    const enhanced = await enhanceAnonymizedScan(png, { width: synth.width, height: synth.height }, undefined, MASK);
    const afterPx = await toPixels(enhanced);
    const mAfter = measure(afterPx, synth.classes, synth.width, synth.height);
    const tag = `cień ${depth}`;

    console.log(row(`${tag} PRZED`, mBefore, png.length));
    console.log(row(`${tag} PO`, mAfter, enhanced.length));

    const meta = await sharp(enhanced).metadata();
    check(`${tag}: wymiary niezmienione`, meta.width === synth.width && meta.height === synth.height,
      `${meta.width}x${meta.height} vs ${synth.width}x${synth.height}`);
    check(`${tag}: brak kanału alfa w zapisie`, meta.hasAlpha === false, `hasAlpha=${String(meta.hasAlpha)}`);
    check(`${tag}: brak orientacji EXIF w zapisie`, meta.orientation === undefined,
      `orientation=${String(meta.orientation)}`);

    const insets = [2, 4, 6, 8, 10];
    const profile = insets
      .map((i) => `${i}px:${minOfRegion(afterPx, MASK.x + i, MASK.y + i, MASK.width - 2 * i, MASK.height - 2 * i)}`)
      .join('  ');
    const plainPx = await toPixels(await sharp(png).jpeg({ quality: DEFAULT_SCAN_ENHANCE.jpegQuality }).toBuffer());
    const plainProfile = insets
      .map((i) => `${i}px:${minOfRegion(plainPx, MASK.x + i, MASK.y + i, MASK.width - 2 * i, MASK.height - 2 * i)}`)
      .join('  ');
    console.log(`${tag}: min maski od brzegu — wzmocniony ${profile}`);
    console.log(`${tag}: min maski od brzegu — bez filtra  ${plainProfile}`);

    // Maska: wnętrze z marginesem 4 px. Progi są z wydrukowanego wyżej pomiaru, nie z sufitu:
    // prostokąt jest DOMALOWANY czystą bielą PO `sharpen`, więc wyostrzenie go nie nadtłusza, ale
    // sam enkoder JPEG q90 robi pierścień na granicy bieli z papierem (przy cieniu 90 sięga 4 px
    // wgłąb i wynosi 255 -> 249). Stąd 248 jako bezwzględny min i tolerancja 8 względem zapisu
    // bez filtra. Odniesienie „≥ 253" z pierwotnej instrukcji jest nieosiągalne dla JAKIEGOKOLWIEK
    // JPEG-a q90 z białym prostokątem — kontrola: wiersz „bez filtra" daje 254 przy cieniu 90.
    const maskMin = minOfRegion(afterPx, MASK.x + 4, MASK.y + 4, MASK.width - 8, MASK.height - 8);
    const plainMaskMin = minOfRegion(plainPx, MASK.x + 4, MASK.y + 4, MASK.width - 8, MASK.height - 8);
    check(`${tag}: maska nadal biała (≥ 248)`, maskMin >= 248, `min=${maskMin}`);
    check(`${tag}: średnia maski > 253`, mAfter.mask.mean > 253, `średnia=${mAfter.mask.mean.toFixed(1)}`);
    check(`${tag}: wzmocnienie nie zjadło maski (≥ zapis bez filtra − 8)`, maskMin >= plainMaskMin - 8,
      `min=${maskMin} vs ${plainMaskMin} bez filtra`);

    check(`${tag}: nierównomierność tła spadła`, mAfter.paper.sd <= mBefore.paper.sd,
      `${mBefore.paper.sd.toFixed(1)} -> ${mAfter.paper.sd.toFixed(1)}`);
    check(`${tag}: tło wyraźnie bielsze`, mAfter.paper.mean >= 240 && mAfter.paper.mean > mBefore.paper.mean,
      `${mBefore.paper.mean.toFixed(1)} -> ${mAfter.paper.mean.toFixed(1)}`);
    check(`${tag}: kontrast pisma nie spadł`, mAfter.contrast >= mBefore.contrast,
      `${mBefore.contrast.toFixed(1)} -> ${mAfter.contrast.toFixed(1)}`);
    check(`${tag}: atrament nie stał się jaśniejszy`, mAfter.ink.mean <= mBefore.ink.mean,
      `${mBefore.ink.mean.toFixed(1)} -> ${mAfter.ink.mean.toFixed(1)}`);
    check(`${tag}: ołówek oddzielony od tła tak samo dobrze`, mAfter.pencilSep >= mBefore.pencilSep,
      `${mBefore.pencilSep.toFixed(1)} -> ${mAfter.pencilSep.toFixed(1)}`);
    check(`${tag}: ołówek nie wypłowiał do tła`, mAfter.pencil.mean < mAfter.paper.mean - 40,
      `ołówek=${mAfter.pencil.mean.toFixed(1)} tło=${mAfter.paper.mean.toFixed(1)}`);
    check(`${tag}: waga w rozsądnym przedziale`,
      enhanced.length > png.length * 0.05 && enhanced.length < png.length * 3,
      `${(png.length / 1024).toFixed(0)} kB -> ${(enhanced.length / 1024).toFixed(0)} kB`);

    // Gradient musi zniknąć, nie tylko się przeskalować — to cała istota flat-fieldu.
    if (depth >= 40) {
      check(`${tag}: cień zniesiony (nierównomierność ≤ 1/3 wejścia)`,
        mAfter.paper.sd <= mBefore.paper.sd / 3,
        `${mBefore.paper.sd.toFixed(1)} -> ${mAfter.paper.sd.toFixed(1)}`);
    }
  }

  // ------------------------------------------------------------------ ścieżka awaryjna
  const synth = buildSynthetic(40);
  const png = await pngOf(synth);
  const fallback = await enhanceAnonymizedScan(png, { width: synth.width + 1, height: synth.height }, undefined, MASK);
  const fallbackPx = await toPixels(fallback);
  const mFallback = measure(fallbackPx, synth.classes, fallbackPx.width, fallbackPx.height);
  const plainReencode = await sharp(png).jpeg({ quality: DEFAULT_SCAN_ENHANCE.jpegQuality }).toBuffer();
  const mPlain = measure(await toPixels(plainReencode), synth.classes, synth.width, synth.height);

  console.log('\n== Ścieżka awaryjna (celowo inne `expected` niż obraz)');
  check(
    'awaryjna ścieżka: inne wymiary → zapis bez wzmocnienia, bez wyjątku',
    fallbackPx.width === synth.width && Math.abs(mFallback.paper.mean - mPlain.paper.mean) < 1,
    `tło awaria=${mFallback.paper.mean.toFixed(1)} vs zwykły zapis=${mPlain.paper.mean.toFixed(1)}`
  );

  // Bufor, który nie jest obrazem: kontroler czyta `sharp(...).metadata()` WCZEŚNIEJ
  // (gradingController.ts:942-953), więc tu taki bufor docierać nie powinien. Moduł nie udaje,
  // że go naprawi — rzuca, a to oznacza brak zapisu, czyli stary zwyczajny błąd 500.
  let garbageThrew = false;
  try {
    await enhanceAnonymizedScan(Buffer.from('to nie jest obraz'), { width: 10, height: 10 });
  } catch {
    garbageThrew = true;
  }
  check('bufor niebędący obrazem → rzut, żadnego zapisu', garbageThrew);

  await fs.promises.writeFile(path.join(TMP, 'synthetic-before.png'), png);
  await fs.promises.writeFile(path.join(TMP, 'synthetic-after.jpg'),
    await enhanceAnonymizedScan(png, { width: synth.width, height: synth.height }, undefined, MASK));

  // ------------------------------------------------------------------ prawdziwy skan
  console.log('\n== Prawdziwy zamazany skan z uploads/anonymized (odczyt; zapis tylko do tmp/)');
  const original = await pickRealScan();

  if (!original) {
    console.log('Brak odkodowalnego skanu — pomijam część drugą.');
  } else {
    const realBeforePx = await toPixels(original);
    const threshold = otsuThreshold(realBeforePx);
    const mRealBefore = measureReal(realBeforePx, threshold);

    // Tak jak w kontrolerze: wzmocnienie dostaje obraz PO masce. Tu maska jest już w pliku.
    const t0 = Date.now();
    const enhancedReal = await enhanceAnonymizedScan(
      await sharp(original).png().toBuffer(),
      { width: realBeforePx.width, height: realBeforePx.height }
    );
    const ms = Date.now() - t0;
    const realAfterPx = await toPixels(enhancedReal);
    const mRealAfter = measureReal(realAfterPx, threshold);

    const line = (label: string, px: Pixels, bytes: number, m: RealMeasure): string =>
      `${label.padEnd(8)} ${px.width}x${px.height} waga=${(bytes / 1024).toFixed(0)} kB ` +
      `tło=${m.paper.mean.toFixed(1)} nierównom=${m.paper.sd.toFixed(1)} kontrast=${m.contrast.toFixed(1)} ` +
      `atrament=${m.ink.mean.toFixed(1)} udział tła=${(m.paperShare * 100).toFixed(0)}%`;

    console.log(line('PRZED', realBeforePx, original.length, mRealBefore));
    console.log(line('PO', realAfterPx, enhancedReal.length, mRealAfter));
    console.log(`próg Otsu z oryginału = ${threshold} (ta sama maska dla obu wierszy), czas wzmocnienia = ${ms} ms`);

    await fs.promises.writeFile(path.join(TMP, 'real-before.jpg'), original);
    await fs.promises.writeFile(path.join(TMP, 'real-after.jpg'), enhancedReal);

    check('skan realny: wymiary niezmienione',
      realAfterPx.width === realBeforePx.width && realAfterPx.height === realBeforePx.height);
    check('skan realny: kontrast nie spadł', mRealAfter.contrast >= mRealBefore.contrast,
      `${mRealBefore.contrast.toFixed(1)} -> ${mRealAfter.contrast.toFixed(1)}`);
    check('skan realny: tło nieściemnione', mRealAfter.paper.mean >= mRealBefore.paper.mean - 0.5,
      `${mRealBefore.paper.mean.toFixed(1)} -> ${mRealAfter.paper.mean.toFixed(1)}`);
    check('skan realny: waga nie urosła ponad 2×', enhancedReal.length < original.length * 2,
      `${(original.length / 1024).toFixed(0)} kB -> ${(enhancedReal.length / 1024).toFixed(0)} kB`);
    check('skan realny: czas wzmocnienia poniżej 2 s', ms < 2000, `${ms} ms`);
  }

  const artifacts = ['synthetic-before.png', 'synthetic-after.jpg', 'real-before.jpg', 'real-after.jpg'];
  for (const f of artifacts) {
    const target = path.join(TMP, f);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  console.log(`\nPliki pomiarowe w ${TMP} zostały skasane; odtworzysz je poleceniem z nagłówka.`);

  console.log(failures ? `\nFAIL: ${failures} asercji` : '\nPASS: wszystkie asercje przeszły');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
