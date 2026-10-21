import sharp from 'sharp';

/**
 * Wzmocnienie skanu przed zapisem, ale zawsze PO zamalowaniu imienia.
 *
 * Kolejność ma znaczenie dla ochrony danych, nie dla urody: każdy etap rozciąga histogram, więc
 * gdyby maskę nakładać po nim, ścieżka awaryjna (`.catch` poniżej) musiałaby zapisywać obraz z
 * widocznym nazwiskiem. Jedyny dozwolony bufor wejściowy to ten po `.composite(overlay)`
 * (gradingController.ts:992-1002) — wszystko, co stąd wychodzi, ma maskę wypaloną w pikselach.
 *
 * Cel to blade pismo i cień rzucany na kartkę przez telefon trzymany jedną ręką, nie „filtr
 * upiększający". Trzy etapy, każdy dobrany pomiarem opisanym w `DEFAULT_SCAN_ENHANCE`:
 *
 *  1. Flat-field: pole oświetlenia to średnia blokowa jasności + rozmycie + interpolacja
 *     biliniowa, a każdy piksel dostaje zysk `target / pole` ograniczony do `[1, maxGain]`.
 *     Dolne ograniczenie `1` jest kluczowe: wzmocnienie może podnieść cień, ale nigdy nie wolno mu
 *     ściemnić tego, co już jest jasne — bez niego silny zysk w jasnym rogu kartki ściąłby biały
 *     prostokąt maski poniżej bieli.
 *     `target` bierze się z percentyla pola, nie z maksimum: jedna przepalona plamka w kadrze nie
 *     ma prawa podbić całej kartki do 255 i zabrać rozpiętości ołówkowi.
 *  2. `linear(a, b)`: domyka resztę papieru do bieli i pogłębia to, co już ciemne. Punkt obrotu
 *     `b / (1 - a)` wypada poniżej atramentu, więc kreska ciemnieje, a papier rozjaśnia się.
 *  3. `sharpen({ sigma })` bez `mcta`: wyostrzenie krawędzi litery. Stałe `sigma`, nie lokalny
 *     histogram, bo lokalny kontrast potrafi zjeść najsłabsze pociągnięcia ołówka.
 *
 * Zakazane, i to nie z zasady, tylko dlatego że płacimy za to jakością odpowiedzi AI:
 * `threshold()` i jakakolwiek binaryzacja (ołówek znika, model odpowiada `missing_evidence`),
 * `flatten({ background })` i `extend` z tłem (realnie zmieniają tło pod maską — ryzyko danych
 * osobowych), `.resize()` w górę (Claude i GPT liczą tokeny wizji z pola pikseli, więc upscaling
 * podrożyłby każdą pracę), `.withMetadata()` (drugi obieg `sharp().toFile()` mógłby przywrócić
 * orientację EXIF i przesunąć maskę) oraz `normalize()` — ten ostatni nie z zasady, tylko z pomiaru
 * w tablicy pod `DEFAULT_SCAN_ENHANCE`.
 *
 * Flat-field liczymy w JS, bo sharp nie ma arytmetyki między obrazami: nie da się podzielić
 * klatki przez jej rozmytą wersję. Koszt to jedna pętla po pikselach — zmierzone 0,6 s dla kadru
 * 1723x2433, czyli zdjęcia z telefonu. Narzucamy go w czasie żądania wprost; zniknięcie drugiego
 * obiegu enkodera zwraca tylko 34 ms z tych ~0,75 s, więc zmiana nie jest bezpłatna.
 */
export interface ScanEnhanceParams {
  fieldBlockPx: number;
  fieldBlurPasses: number;
  fieldPercentile: number;
  fieldTargetCap: number;
  maxGain: number;
  linearA: number;
  linearB: number;
  sharpenSigma: number;
  jpegQuality: number;
}

/**
 * Dobrane pomiarem, nie zgadywanką — `backend/scripts/test-scan-enhancement.ts` liczy
 * nierównomierność tła, kontrast atramentu i separatki ołówka na syntetyku z trzema siłami cienia
 * oraz na prawdziwych zamazanych skanach z `uploads/anonymized/`. Wiersze poniżej to kadr z
 * najgłębszym cieniem (głębokość 90); kolumny są średnimi luminancji klas pikseli znanych
 * z konstrukcji obrazu, więc żaden podział nie jest wyznaczany progiem na samym sobie. Każdy wiersz
 * odtworzysz jednym poleceniem z nagłówka tego skryptu.
 *
 * ```text
 * wariant (ścieżka)                             tło     nierównom.  atrament  ołówek
 * wejście                                       182,6   25,1        58,0      152,0
 * normalize → gamma → linear → sharpen          138,5   90,6         1,2        1,0
 * bez flat-fieldu (linear → sharpen)            222,2   28,7        14,3      158,0
 * flat-field bez linear                         215,8    7,2        33,9      140,9
 * flat-field bez sharpen                        254,8    1,4        70,7      198,0
 * niniejszy (flat-field → linear → sharpen)     254,8    1,7        25,4      169,7
 * ```
 *
 * Wiersz 2 to kolejność zapisana w pierwotnej instrukcji („normalize na percentylach, potem gamma").
 * Zmierzony, jest szkodliwy: `normalize()` w sharp 0.35.5 nie tylko rozciąga histogram — on realnie
 * CIEMNI papier (182,6 → 138,5), potraja nierównomierność i zabija grafit (ołówek 152,0 → 1,0, czyli
 * zrównuje się z atramentem). Dlatego stąd zniknął: gradient usuwamy lokalnie, a nie globalnym
 * rozciągnięciem. Wiersz 3 dowodzi reszty — samo `linear` pozostawia cień nietknięty (28,7, czyli
 * nawet gorzej niż na wejściu), a to właśnie cień jest tym, na co nauczyciel patrzy. Wiersze 4 i 5
 * mówią, po co dwie pozostałe operacje: bez `linear` papier zostaje szary, bez `sharpen` atrament
 * jest dwukrotnie bledszy.
 *
 * Zmiana którejkolwiek wartości bez ponownego pomiaru to regresja jakości oceny, a nie tuning.
 */
export const DEFAULT_SCAN_ENHANCE: ScanEnhanceParams = {
  fieldBlockPx: 32,
  fieldBlurPasses: 2,
  fieldPercentile: 90,
  fieldTargetCap: 250,
  maxGain: 1.6,
  linearA: 1.35,
  linearB: -20,
  sharpenSigma: 0.8,
  jpegQuality: 90,
};

export interface ExpectedDimensions {
  width: number;
  height: number;
}

interface RawImage {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
}

async function decode(masked: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(masked).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, channels: info.channels, data };
}

/**
 * Pole oświetlenia w pełnej rozdzielczości. Robocza siatka to średnie blokowe (downsample), potem
 * rozmycie separatnym, na końcu interpolacja biliniowa — dzięki temu duży cień na kartce kosztuje
 * kilkadziesiąt milisekund, a nie pełnowymiarową konwolucję.
 */
function lightField(image: RawImage, blockPx: number, passes: number): Float32Array {
  const { width, height, channels, data } = image;
  const lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    lum[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  const bw = Math.max(2, Math.ceil(width / blockPx));
  const bh = Math.max(2, Math.ceil(height / blockPx));
  const grid = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let sum = 0;
      let count = 0;
      for (let y = by * blockPx; y < Math.min((by + 1) * blockPx, height); y++) {
        for (let x = bx * blockPx; x < Math.min((bx + 1) * blockPx, width); x++) {
          sum += lum[y * width + x];
          count++;
        }
      }
      grid[by * bw + bx] = sum / count;
    }
  }

  const blurRows = (src: Float32Array): Float32Array => {
    const dst = new Float32Array(src.length);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const at = (i: number) => src[y * bw + Math.min(bw - 1, Math.max(0, i))];
        dst[y * bw + x] = (at(x - 2) + 2 * at(x - 1) + 3 * at(x) + 2 * at(x + 1) + at(x + 2)) / 9;
      }
    }
    return dst;
  };
  const blurCols = (src: Float32Array): Float32Array => {
    const dst = new Float32Array(src.length);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const at = (j: number) => src[Math.min(bh - 1, Math.max(0, j)) * bw + x];
        dst[y * bw + x] = (at(y - 2) + 2 * at(y - 1) + 3 * at(y) + 2 * at(y + 1) + at(y + 2)) / 9;
      }
    }
    return dst;
  };
  let field: Float32Array = grid;
  for (let pass = 0; pass < passes; pass++) field = blurCols(blurRows(field));

  const out = new Float32Array(width * height);
  const scaleX = (bw - 1) / (width - 1);
  const scaleY = (bh - 1) / (height - 1);
  for (let y = 0; y < height; y++) {
    const fy = y * scaleY;
    const y0 = Math.min(bh - 2, Math.floor(fy));
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = x * scaleX;
      const x0 = Math.min(bw - 2, Math.floor(fx));
      const tx = fx - x0;
      const a = field[y0 * bw + x0];
      const b = field[y0 * bw + x0 + 1];
      const c = field[(y0 + 1) * bw + x0];
      const d = field[(y0 + 1) * bw + x0 + 1];
      out[y * width + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

function percentile(sorted: Float32Array, pct: number): number {
  const index = Math.min(sorted.length - 1, Math.floor((pct / 100) * (sorted.length - 1)));
  return sorted[index];
}

/**
 * Prostokąt, którym kontroler zamalował imię i nazwisko. Opcjonalny, ale powinien być przekazywany
 * zawsze: `sharpen` daje pierścień na każdym mocnym brzegu, a brzeg biały prostokąt / papier to
 * właśnie taki brzeg. Bez domalowania maska w syntetyce z mocnym cieniem schodziła z 254 do 249.
 */
export interface RedactionRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Czysto biały prostokąt maski, przycięty do ramki. Współrzędne ścinamy do liczb całkowitych, bo
 * `composite` ich wymaga, a zwracamy je razem z buforem — wywołanie niżej używa właśnie tej pary.
 */
async function whiteOverlay(
  region: RedactionRegion,
  frame: ExpectedDimensions
): Promise<{ buffer: Buffer; left: number; top: number } | null> {
  const left = Math.max(0, Math.floor(region.x));
  const top = Math.max(0, Math.floor(region.y));
  const width = Math.min(Math.floor(region.width), frame.width - left);
  const height = Math.min(Math.floor(region.height), frame.height - top);
  if (width <= 0 || height <= 0) return null;

  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toBuffer();

  return { buffer, left, top };
}

/**
 * Zwraca JPEG gotowy do zapisania pod `filepath`. Nie rzuca dla obrazu, który dał się zdekodować:
 * wzmocnienie jest dodatkiem do anonimizacji, a anonimizacja jest obrazem pracy ucznia. Jeśli
 * cokolwiek pójdzie nie tak (odmowa pipeline'u albo inne wymiary niż przed), kontroler dostaje
 * dokładnie to, co dostawał wczoraj, czyli zamazany skan bez wzmocnienia. Wyjątek przechodzi tylko
 * wtedy, gdy bufor wejściowy w ogóle nie jest obrazem — a ten kontroler bada `metadata()` wcześniej
 * (gradingController.ts:945-949), więc taki wypadek do tej funkcji nie dociera.
 *
 * Każda ścieżka wyjścia — wzmocniona i awaryjna — dostaje maskę danych osobowych. Awaryjna bierze
 * ją z bufora wejściowego, który kontroler podaje już po `.composite(overlay)`.
 */
export async function enhanceAnonymizedScan(
  masked: Buffer,
  expected: ExpectedDimensions,
  params: ScanEnhanceParams = DEFAULT_SCAN_ENHANCE,
  redaction?: RedactionRegion
): Promise<Buffer> {
  const plainJpeg = () => sharp(masked).jpeg({ quality: params.jpegQuality }).toBuffer();

  let enhanced: Buffer;

  try {
    const image = await decode(masked);

    if (image.width !== expected.width || image.height !== expected.height) {
      console.warn(
        `[scan-enhancement] dekoder zwrócił ${image.width}x${image.height} zamiast ` +
          `${expected.width}x${expected.height}, zapisuję skan bez wzmocnienia`
      );
      return plainJpeg();
    }

    const field = lightField(image, params.fieldBlockPx, params.fieldBlurPasses);
    const target = Math.min(percentile(Float32Array.from(field).sort(), params.fieldPercentile), params.fieldTargetCap);

    const corrected = Buffer.alloc(image.data.length);
    for (let i = 0; i < image.width * image.height; i++) {
      const p = i * image.channels;
      const gain = Math.max(1, Math.min(params.maxGain, target / Math.max(1, field[i])));
      for (let ch = 0; ch < image.channels; ch++) {
        corrected[p + ch] = Math.min(255, Math.round(image.data[p + ch] * gain));
      }
    }

    const mask = redaction ? await whiteOverlay(redaction, expected) : null;
    if (redaction && !mask) {
      console.warn('[scan-enhancement] prostokąt maski poza ramką — nie domalowuję bieli, pierścień sharpen zostanie na masce');
    }

    let pipeline = sharp(corrected, {
      raw: {
        width: image.width,
        height: image.height,
        channels: image.channels as 3 | 4,
      },
    }).linear(params.linearA, params.linearB).sharpen({ sigma: params.sharpenSigma });

    if (mask) {
      pipeline = pipeline.composite([{ input: mask.buffer, left: mask.left, top: mask.top }]);
    }

    enhanced = await pipeline.jpeg({ quality: params.jpegQuality }).toBuffer();
  } catch (error) {
    console.warn(
      '[scan-enhancement] pipeline odrzucony, zapisuję skan bez wzmocnienia:',
      (error as Error).message
    );
    return plainJpeg();
  }

  const meta = await sharp(enhanced).metadata();

  if (meta.width !== expected.width || meta.height !== expected.height) {
    console.warn(
      `[scan-enhancement] wymiary się zmieniły (${expected.width}x${expected.height} -> ` +
        `${meta.width ?? '?'}x${meta.height ?? '?'}), zapisuję skan bez wzmocnienia`
    );
    return plainJpeg();
  }

  return enhanced;
}
