import openai from '../config/openai';
import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import fs from 'fs';

/**
 * Etykieta, jak model uzasadnia swoje punkty. JEDYNE źródło pewności w systemie: liczby 0-100 model
 * nigdy nie wydaje, bo samodeklaracja bez kryteriów jest wróżeniem. Etykiety są cztery i każda ma
 * przypisaną stałą w CERTAINTY_CONFIDENCE.
 */
export type TaskCertainty = 'certain' | 'key_ambiguous' | 'reading_uncertain' | 'missing_evidence';

export const TASK_CERTAINTIES: readonly TaskCertainty[] = [
  'certain',
  'key_ambiguous',
  'reading_uncertain',
  'missing_evidence',
];

/**
 * Waga etykiety w punkcie pracy. Kolejność nie jest symetryczna: „przeczytałem źle" jest gorsze niż
 * „klucz nie rozstrzyga", bo w pierwszym punkty ucznia mogą być po prostu pomylone, a w drugim
 * nauczyciel przynajmniej ogląda ten sam tekst, co model.
 */
const CERTAINTY_CONFIDENCE: Record<TaskCertainty, number> = {
  certain: 100,
  key_ambiguous: 80,
  reading_uncertain: 55,
  missing_evidence: 30,
};

/** Surowy wiersz jednego podpunktu w odpowiedzi modelu. */
export type ModelSubItemOutput = {
  id: string;
  transcription: string;
  points: number;
  certainty: TaskCertainty;
};

/** Surowa odpowiedź modelu — żadnych pól o pewności. */
export type ModelGradingOutput = {
  total_score: number;
  tasks: Array<{
    task_number: number;
    transcription: string;
    points: number;
    certainty: TaskCertainty;
    comment: string;
    /**
     * Obecne, gdy zadanie w kluczu ma podpunkty. Model nie ma wtedy pola, w którym mógłby
     * zapisać sumę kłócącą się z jego własnymi ocenami podpunktów — sumę liczy kod.
     */
    sub_items?: ModelSubItemOutput[];
  }>;
};

/** Podpunkt po rozliczeniu: co model widział, ile mu przyznał i jak bardzo był tego pewien. */
export interface GradedSubItem {
  id: string;
  transcription: string;
  points: number;
  max_points: number;
  certainty: TaskCertainty;
  /** 0-100 z CERTAINTY_CONFIDENCE tego podpunktu, z obejściem na pusty transkrypt. */
  confidence: number;
}

/**
 * STRUKTURA WYNIKU AI - Strict Schema
 */
export interface AIGradingResult {
  /** 0-100, wyliczone w derivePaperConfidence. Nigdy nie pochodzi od modelu. */
  confidence_score: number;
  /** Suma tasks[].points policzona w kodzie, nie zadeklarowana przez model. */
  total_score: number;
  tasks: Array<{
    task_number: number;
    points: number;
    comment: string; // Po polsku
    /** Dosłowne, co model odczytał z kartki w tym zadaniu. Puste = brak dowodu. */
    transcription: string;
    certainty: TaskCertainty;
    /** 0-100 z deriveTaskConfidence, ważne przy punktacji ważonej. */
    confidence: number;
    /**
     * Zadanie z podpunktami: ich rozliczone wiersze. Dla takiego zadania `points`,
     * `transcription`, `certainty` i `confidence` powyżej są WYPROWADZONE z podpunktów,
     * a nie przepisane od modelu — model ocenia podpunkt, kod ocenia zadanie.
     */
    sub_items?: GradedSubItem[];
  }>;
}

/**
 * JSON Schema wymuszana po stronie API Anthropic (structured outputs).
 * Musi pozostać lustrzanym odbiciem ModelGradingOutput.
 *
 * Kolejność jest częścią mechaniki: `tasks` przed `total_score`, a w zadaniu `sub_items` przed
 * polami podsumowującymi i `transcription` przed `points`. Model generuje pola w tej kolejności,
 * więc ma za sobą cały wysiłek odczytania i wycenienia podpunktów, zanim zacznie cokolwiek
 * podsumowywać. Odwrotna kolejność (pewność jako pierwsze pole) sprawiała, że liczba powstawała,
 * zanim model przejrzał którekolwiek zadanie.
 */
const GRADING_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          task_number: { type: 'integer' },
          sub_items: {
            type: 'array',
            description:
              'Tylko gdy zadanie w kluczu ma podpunkty: dokładnie jeden wiersz o tej samej etykiecie dla KAŻDEGO podpunktu. Punkty zadania są sumą tych wierszy, więc nie ma tu miejsca na własną sumę.',
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  description: 'Etykieta podpunktu dokładnie taka jak w kluczu, np. "a".',
                },
                transcription: {
                  type: 'string',
                  description:
                    'Dosłownie to, co uczeń napisał w tym podpunkcie. Brak odpowiedzi = "brak odpowiedzi". Nie parafrazuj.',
                },
                points: { type: 'number', minimum: 0 },
                certainty: { type: 'string', enum: [...TASK_CERTAINTIES] },
              },
              required: ['id', 'transcription', 'points', 'certainty'],
              additionalProperties: false,
            },
          },
          transcription: {
            type: 'string',
            description:
              'Dosłownie to, co widzisz w odpowiedzi ucznia (równanie, wyliczenie, jedno słowo). Brak odpowiedzi na kartce = "brak odpowiedzi". Nie parafrazuj, nie streszczaj, nie oceniaj w tym polu.',
          },
          points: { type: 'number', minimum: 0 },
          certainty: { type: 'string', enum: [...TASK_CERTAINTIES] },
          comment: { type: 'string', description: 'Komentarz po polsku, maksymalnie 2-3 zdania' },
        },
        required: ['task_number', 'transcription', 'points', 'certainty', 'comment'],
        additionalProperties: false,
      },
    },
    total_score: { type: 'number' },
  },
  required: ['tasks', 'total_score'],
  additionalProperties: false,
} as const;

/**
 * Typy modeli AI
 */
type ModelTier = 'fast' | 'premium';

interface ModelConfig {
  tier: ModelTier;
  provider: 'google' | 'openai' | 'anthropic';
  model: string;
}

/**
 * KONFIGURACJA MODELI
 */
const MODELS: Record<ModelTier, ModelConfig> = {
  fast: {
    tier: 'fast',
    provider: 'anthropic',
    model: 'claude-haiku-5-5', // tani / szybki kombajn
  },
  premium: {
    tier: 'premium',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5', // dokładniejszy, droższy
  },
};

/**
 * PRÓG CONFIDENCE SCORE dla eskalacji do premium modelu
 */
const CONFIDENCE_THRESHOLD = 75;

/**
 * PROMPT SYSTEMOWY - Rygorystyczny egzaminator
 */
function buildSystemPrompt(): string {
  return `Jesteś profesjonalnym i sprawiedliwym egzaminatorem. Oceniasz zanonimizowany sprawdzian ucznia na podstawie dostarczonego Kluczu Odpowiedzi.

PROCEDURA — dla KAŻDEGO zadania z klucza, w jego numeracji, dokładnie jedna pozycja wyniku:
1. Jeśli zadanie ma w kluczu podpunkty (a, b, c...), zacznij od 'sub_items': jeden wiersz z dokładnie tą samą etykietą dla KAŻDEGO podpunktu, z jego własnym transkryptem, punktami i etykietą pewności. Punkty zadania będą sumą tych wierszy — nie masz osobnego pola na własną sumę.
2. 'transcription': przepisz DOSŁOWNIE, co uczeń napisał w tym zadaniu (wynik, równanie, jedno słowo, narysowaną figurę jednym słowem). Nie parafrazuj, nie streszczaj, nie komentuj, nie poprawiaj. Jeśli w zadaniu nie ma żadnej odpowiedzi, wpisz dokładnie: "brak odpowiedzi". Jeśli kartka w tym miejscu jest urwana, zasłonięta przez krawędź skanu albo nie znajdziesz jej — wpisz, co tam faktycznie widzisz, np. "brak strony z tym zadaniem".
3. 'points': przyznaj wyłącznie tyle, ile wynosi lub dopuszcza klucz (0 do wartości maksymalnej zadania). Nie dokończaj i nie poprawiaj obliczeń ucznia we własnej głowie — oceniasz dokładnie to, co jest na kartce. Przy zadaniu z podpunktami wpisz sumę swoich wierszy z 'sub_items'.
4. 'certainty': wybierz JEDNĄ etykietę z opisu poniżej; przy zadaniu z podpunktami wybierz etykietę najgorszego z nich.
5. 'comment': po polsku, maksymalnie 2-3 zdania, konstruktywnie.

PODPUNKTY — gdy zadanie jest rozbite na a, b, c:
- Każdy podpunkt oceniasz osobno i dostaje on wyłącznie swoją stawkę z klucza: poprawny całą, nieprawny zero.
- Liczba poprawnych podpunktów to NIE liczba punktów. Dwa poprawne z czterech po 0,5 pkt dają 1 pkt, a nie 2. Zawsze mnoż liczbę poprawnych przez stawkę podpunktu.
- Nie rozwiązuj zadania ucznia na nowo i nie sprawdzaj, który znak „powinien" wyjść. Porównuj wyłącznie z odpowiedzią zapisaną w kluczu przy tym konkretnym podpunkcie — pomylenie, który układ należy do a, a który do c, jest najczęstszym błędem przy takich zadaniach.
- Jeśli uczeń odpowiedział w podpunkcie inaczej niż klucz, ale odpowiedź jest merytorycznie równoważna (inna jednostka, skrócony ułamek), przyznaj punkty i oznacz ten podpunkt 'key_ambiguous'.

ETYKIETY PEWNOŚCI — wybierz tę, która najuczciwiej opisuje Twoje wątpliwości, i tylko tę:
- 'certain': odpowiedź ucznia odczytałeś bez cienia wątpliwości i klucz rozstrzyga ją wprost. Dotyczy to RÓWNIEŻ pracy wyraźnie błędnej i zadania bez odpowiedzi — pewne zero jest pewne. To domyślna etykieta; większość dobrze wykonanej pracy to 'certain'.
- 'key_ambiguous': odczytałeś odpowiedź bez problemu, ale klucz nie przewiduje tak postawionego przypadku (inna metoda, dodatkowa jednostka, odpowiedź częściowa, którą klucz opisuje dwuznacznie). W takich sytuacjach przyznaj punkty zgodnie z najlepszą wiedzą i oznacz 'key_ambiguous'.
- 'reading_uncertain': litera, cyfra albo znak mogą zostać odczytane inaczej niż odczytałeś (pismo odręczne, zamazane miejsce, skreślenie, ołówek, światło). Jeśli istnieje inny sensowny odczyt, który zmieniłby punkty — to jest ta etykieta.
- 'missing_evidence': fragment pracy niezbędny do oceny nie jest dostępny (urwana strona, zadanie poza kadrem, całkowicie nieczytelne). Wtedy punkty wynoszą 0.

ZASADY ROZLICZENIA PEWNOŚCI:
- Nie podajesz żadnej liczby pewności. System wylicza ją sam z Twoich etykiet i z Twoich transkryptów, ważąc zadania ich maksymalną punktacją.
- Etykieta ma opisać Twój stan wiedzy, nie wyjść korzystnie. Obniżona etykieta NIE obniża oceny ucznia i nic Cię nie kosztuje. Zawyżona etykieta jest błędem w rozliczeniu i sprawi, że praca z Twoimi punktami nigdy nie trafi do drugiego, dokładniejszego modelu.
- Sto punktów pewności dla pracy jest możliwe wyłącznie wtedy, gdy każde zadanie ma 'certain' i niepusty transkrypt. Jeśli czegoś nie jesteś pewien — nie oznaczaj tego jako 'certain'.
- Masz obowiązek oznaczyć 'reading_uncertain' albo 'missing_evidence' zawsze, gdy obraz jest nieostry, ucięty, przekrzywiony, albo gdy widzisz tylko część pracy. To nie jest porażka, to jest informacja dla nauczyciela.
- Analizuj treść merytoryczną; ignoruj drobne błędy ortograficzne, chyba że klucz stanowi inaczej.

KRYTYCZNE: Zwróć wyłącznie surowy obiekt JSON. NIE owijaj kodu w bloki markdown typu \`\`\`json \`\`\`. NIE dodawaj żadnych wstępów, nagłówków ani podsumowań. Odpowiedź musi zaczynać się od { i kończyć na }. Żadnego dodatkowego tekstu.`;
}

/**
 * Punkty w polskim zdaniu: 0.5 → „0,5". Odpowiedź modelu i tak idzie liczbą z kropką, bo tak
 * nakazuje schemat JSON, ale klucz, który model czyta, jest po polsku i przecinek dziesiętny
 * musi w nim być. Całkowite wartości renderują się identycznie jak wcześniej, więc prefiks
 * cache'a Anthropic dla istniejących kluczy nie drgnie.
 */
function formatPoints(value: number): string {
  return String(value).replace('.', ',');
}

/**
 * Lista podpunktów w jednym, wspólnym formacie — używana i w cache'owanym bloku Claude, i w
 * tekstowym prompcie GPT-4o. Dwie ścieżki muszą widzieć dokładnie tę samą treść klucza.
 */
function formatSubItems(subItems: any[]): string {
  return subItems
    .map((sub) => `   ${sub.id}) ${sub.correct_answer} — ${formatPoints(sub.max_points)} pkt`)
    .join('\n');
}

/**
 * Buduje cache'owalny blok z kluczem odpowiedzi (bez sekcji formatu JSON)
 */
function buildAnswerKeyBlock(answerKey: any): string {
  const tasks = answerKey.tasks || [];
  const totalPoints = answerKey.total_points || 0;

  let prompt = `**Klucz odpowiedzi:**\n`;
  prompt += `Maksymalna liczba punktów: ${formatPoints(totalPoints)}\n\n`;

  tasks.forEach((task: any) => {
    prompt += `Zadanie ${task.id}: (${formatPoints(task.max_points)} pkt)\n`;

    // Zadanie rozbite na podpunkty ma odpowiedzi w ich listach; własne zdanie zostawiamy tylko
    // wtedy, gdy nauczyciel coś wpisał. Pusta linia „Poprawna odpowiedź:" nic nie wnosi.
    const answer = typeof task.correct_answer === 'string' ? task.correct_answer.trim() : '';
    if (answer) {
      prompt += `Poprawna odpowiedź: ${answer}\n`;
    }

    const subItems = Array.isArray(task.sub_items) ? task.sub_items : [];
    if (subItems.length > 0) {
      prompt += `Podpunkty — oceniane osobno, ich punkty sumują się do ${formatPoints(task.max_points)} pkt:\n`;
      prompt += `${formatSubItems(subItems)}\n`;
    }

    if (task.guidelines) {
      prompt += `Wytyczne: ${task.guidelines}\n`;
    }
    prompt += `\n`;
  });

  return prompt;
}

/**
 * Pełny prompt dla ścieżek bez formatu wymuszonego przez API.
 * Claude dostaje schemat przez output_config, GPT-4o musi go dostać w tekście.
 */
function buildUserPrompt(answerKey: any): string {
  let prompt = `Oceń tę pracę ucznia według poniższego klucza odpowiedzi.\n\n`;
  prompt += buildAnswerKeyBlock(answerKey);
  prompt += `\n**WAŻNE: Format odpowiedzi (TYLKO czysty JSON, BEZ \`\`\`json):**\n`;
  prompt += `{\n`;
  prompt += `  "tasks": [\n`;
  prompt += `    { "task_number": 1, "sub_items": [ { "id": "a", "transcription": "dosłownie, co uczeń napisał w tym podpunkcie", "points": <punkty>, "certainty": "certain" | "key_ambiguous" | "reading_uncertain" | "missing_evidence" } ], "transcription": "dosłownie, co uczeń napisał", "points": <punkty>, "certainty": "certain" | "key_ambiguous" | "reading_uncertain" | "missing_evidence", "comment": "Krótki komentarz (max 2-3 zdania)" }\n`;
  prompt += `  ],\n`;
  prompt += `  "total_score": <suma punktów>\n`;
  prompt += `}\n\n`;
  prompt += `"sub_items" podajesz WYŁĄCZNIE dla zadań, które w kluczu mają podpunkty — jeden wiersz na każdy podpunkt, z jego etykietą. Punkty zadania to suma punktów jego podpunktów.\n`;
  prompt += `Nie podajesz żadnej liczby pewności — system wylicza ją sam z etykiet 'certainty' i z transkryptów. Oddaj dokładnie jedną pozycję "tasks" dla KAŻDEGO zadania z klucza.\n\n`;
  prompt += `Zwróć TYLKO ten JSON. Bez markdown, bez dodatkowych słów.`;

  return prompt;
}

/**
 * Numer zadania dokładnie tak, jak liczy go interfejs: klucz numeruje pozycje po `id`, a `id` nie
 * zawsze jest liczbą. Rozjedzie się z tabelą punktów, jeśli któraś ze stron zastosuje inną regułę,
 * więc to lustrzany zapis frontendowego taskNumberFromId.
 */
function taskNumberFromId(taskId: unknown, index: number): number {
  const asNumber = Number(taskId);
  return Number.isInteger(asNumber) ? asNumber : index + 1;
}

/** Etykieta podpunktu sprowadzona do tego, co ją rozróżnia: model odda „A" zamiast „a". */
function subKey(id: unknown): string {
  return typeof id === 'string' ? id.trim().toLocaleLowerCase() : '';
}

type KeySubSpec = { id: string; key: string; maxPoints: number };
type KeyTaskSpec = { maxPoints: number; subs: KeySubSpec[] };

/**
 * Klucz zadania, którego potrzebujemy do rozliczenia: jego maksimum i lista podpunktów.
 * Numery zadań liczymy tak samo jak interfejs (`taskNumberFromId`), więc ten sam wiersz
 * resultu trafia pod tę samą pozycję tabeli po obu stronach.
 */
function keyTaskSpecs(answerKey: any): Map<number, KeyTaskSpec> {
  const tasks = Array.isArray(answerKey?.tasks) ? answerKey.tasks : [];
  const specs = new Map<number, KeyTaskSpec>();

  tasks.forEach((task: any, index: number) => {
    const maxPoints = Number(task?.max_points);
    const rawSubs = Array.isArray(task?.sub_items) ? task.sub_items : [];

    const subs: KeySubSpec[] = rawSubs.map((sub: any) => {
      const id = typeof sub?.id === 'string' ? sub.id.trim() : String(sub?.id ?? '');
      const points = Number(sub?.max_points);
      return { id, key: subKey(id), maxPoints: Number.isFinite(points) && points > 0 ? points : 0 };
    });

    specs.set(taskNumberFromId(task?.id, index), {
      maxPoints: Number.isFinite(maxPoints) && maxPoints > 0 ? maxPoints : 0,
      subs: subs.filter((sub: KeySubSpec) => sub.key),
    });
  });

  return specs;
}

function isCertainty(value: unknown): value is TaskCertainty {
  return typeof value === 'string' && (TASK_CERTAINTIES as readonly string[]).includes(value);
}

function roundPoints(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Pewność z etykiety i transkryptu — niezależnie od poziomu. Osobna funkcja, bo jest jedno
 * obejście, którego nie da się wyrazić enumeracją: pusty transkrypt przy przyznanych punktach
 * znaczy, że model przyznał coś, czego nie umie wskazać na kartce. To brak dowodu, niezależnie
 * od tego, co sam o sobie napisał, i dotyczy tak całego zadania, jak i jednego podpunktu.
 */
function deriveConfidence(row: { transcription: string; points: number; certainty: TaskCertainty }): number {
  const base = CERTAINTY_CONFIDENCE[row.certainty];
  if (!row.transcription.trim() && row.points > 0) {
    return Math.min(base, CERTAINTY_CONFIDENCE.missing_evidence);
  }
  return base;
}

/**
 * Jedna reguła ważenia na obu poziomach rozliczenia: ile punktów NIE trzyma się na dowodzie.
 * Podpunkty ważymy ich stawką wewnątrz zadania, zadania ich stawką wewnątrz pracy — dzięki temu
 * „kruchy podpunkt za 0,5" i „kruche zadanie za 10" zachowują się proporcjonalnie, a 100 wychodzi
 * wyłącznie wtedy, gdy każdy element składowy jest pewny.
 */
function weightedConfidence(entries: Array<{ weight: number; confidence: number }>): number {
  let totalWeight = 0;
  let doubtfulWeight = 0;

  for (const entry of entries) {
    // Pozycja bez wagi nie może być wolna od konsekwencji, inaczej model ominąłby najtrudniejsze punkty.
    const effective = entry.weight > 0 ? entry.weight : 1;
    totalWeight += effective;
    doubtfulWeight += (effective * (100 - entry.confidence)) / 100;
  }

  if (totalWeight <= 0) return 0;

  return Math.round(100 - (100 * doubtfulWeight) / totalWeight);
}

/**
 * Moment, w którym musimy ingerować w odpowiedzi modelu, bo rozmijają się z kluczem: punkty ponad
 * maksimum, pozycja spoza klucza albo zignorowana struktura podpunktów. Taka odpowiedź nie mogła
 * powstać z rzetelnej lektury, więc całą pracę ciągniemy w dół do tego pułapu — punktów ucznia nie
 * zmieniamy więcej, niż wymaga klucz.
 */
const UNSOUND_RESULT_CAP = 40;

/** Pewność całej pracy z pewności jej zadań, ważonych maksymalną punktacją z klucza. */
function derivePaperConfidence(tasks: AIGradingResult['tasks'], specs: Map<number, KeyTaskSpec>): number {
  return weightedConfidence(
    tasks.map((task) => ({ weight: specs.get(task.task_number)?.maxPoints ?? 0, confidence: task.confidence }))
  );
}

/**
 * Które zadania nie są 'certain' i ile przez to ważą — wyłącznie do logu, żeby na nową skalę dało się
 * patrzeć na prawdziwych kartkach bez żonglowania odpowiedzią modelu.
 */
function shakyTasks(result: AIGradingResult): string {
  const shaky = result.tasks.filter((task) => task.certainty !== 'certain');
  if (shaky.length === 0) return 'brak';

  return shaky.map((task) => `Z${task.task_number} ${task.certainty}=${task.confidence}`).join(', ');
}

type RawTaskRow = ModelGradingOutput['tasks'][number];

/**
 * Rozlicza podpunkty jednego zadania. Zwraca ich wiersze w kolejności z klucza i mówi, czy
 * odpowiedź modelu rozmijała się z kluczem (podpunkt spoza klucza, punkty ponad jego stawkę,
 * któryś podpunkt pominięty).
 *
 * Null, gdy model nie oddał ŻADNEGO podpunktu. Wtedy jedyną rzeczą, którą o tym zadaniu wiemy,
 * jest jego wiersz zbiorczy — zerować uczniowi punkty za brak formatki nie wolno, więc wynik
 * zostaje, a praca jedzie do dokładniejszego modelu.
 */
function gradeSubItems(entry: RawTaskRow, spec: KeyTaskSpec): { subs: GradedSubItem[]; unsound: boolean } | null {
  const declaredRows = Array.isArray(entry.sub_items) ? entry.sub_items : [];
  const byKey = new Map<string, GradedSubItem>();
  let unsound = false;

  for (const declared of declaredRows) {
    const key = subKey(declared?.id);
    if (!key || byKey.has(key)) continue;

    const known = spec.subs.find((sub) => sub.key === key);
    if (!known) {
      // Podpunkt, którego nie ma w kluczu, nie ma stawki ani poprawnej odpowiedzi.
      unsound = true;
      continue;
    }

    const declaredPoints = Number(declared?.points);
    let points = Number.isFinite(declaredPoints) && declaredPoints > 0 ? declaredPoints : 0;
    if (known.maxPoints > 0 && points > known.maxPoints) {
      points = known.maxPoints;
      unsound = true;
    }

    const transcription = typeof declared?.transcription === 'string' ? declared.transcription.trim() : '';
    const certainty: TaskCertainty = isCertainty(declared?.certainty) ? declared.certainty : 'missing_evidence';

    byKey.set(key, {
      id: known.id,
      transcription,
      points,
      max_points: known.maxPoints,
      certainty,
      confidence: deriveConfidence({ transcription, points, certainty }),
    });
  }

  if (byKey.size === 0) return null;
  if (byKey.size < spec.subs.length) unsound = true;

  const subs = spec.subs.map(
    (sub) =>
      byKey.get(sub.key) ?? {
        id: sub.id,
        transcription: '',
        points: 0,
        max_points: sub.maxPoints,
        certainty: 'missing_evidence' as TaskCertainty,
        confidence: CERTAINTY_CONFIDENCE.missing_evidence,
      }
  );

  return { subs, unsound };
}

/**
 * Zamienia surową odpowiedź modelu na rozliczony wynik: normalizuje pozycje, rozlicza podpunkty,
 * dopisuje zadania, których model nie oddał, liczy sumę punktów sam i wyprowadza obie liczby
 * pewności.
 *
 * Eksportowane po to, żeby tę arytmetykę dało się zbadać bez płacenia za wywołanie modelu.
 */
export function finalizeGradingOutput(raw: ModelGradingOutput, answerKey: any): AIGradingResult {
  const specs = keyTaskSpecs(answerKey);
  const byNumber = new Map<number, AIGradingResult['tasks'][number]>();
  let unsound = false;

  for (const entry of raw.tasks) {
    const number = Math.trunc(Number(entry.task_number));
    if (!Number.isInteger(number) || byNumber.has(number)) continue;

    // Zadanie, którego nie ma w kluczu, nie ma ani maksymalnej punktacji, ani poprawnej odpowiedzi,
    // więc nie ma czym go ocenić. Ścieżka poprawek nauczyciela buduje wiersze wyłącznie z klucza —
    // tutaj nie może być inaczej, bo ten sam wynik miałby dwie różne sumy.
    const spec = specs.get(number);
    if (!spec) {
      unsound = true;
      continue;
    }

    const declared = Number(entry.points);
    let points = Number.isFinite(declared) && declared > 0 ? declared : 0;
    if (spec.maxPoints > 0 && points > spec.maxPoints) {
      points = spec.maxPoints;
      unsound = true;
    }

    const transcription = typeof entry.transcription === 'string' ? entry.transcription.trim() : '';
    const certainty: TaskCertainty = isCertainty(entry.certainty) ? entry.certainty : 'missing_evidence';
    const comment = typeof entry.comment === 'string' ? entry.comment : '';

    if (spec.subs.length > 0) {
      const graded = gradeSubItems(entry, spec);

      if (graded) {
        unsound = unsound || graded.unsound;

        const subPoints = roundPoints(graded.subs.reduce((sum, sub) => sum + sub.points, 0));
        const worst = graded.subs.reduce(
          (worst, sub) => (CERTAINTY_CONFIDENCE[sub.certainty] < CERTAINTY_CONFIDENCE[worst.certainty] ? sub : worst),
          graded.subs[0]
        );

        byNumber.set(number, {
          task_number: number,
          // Zadanie nie ma już własnej punktacji do obrony: jest nią suma podpunktów.
          points: spec.maxPoints > 0 ? Math.min(subPoints, spec.maxPoints) : subPoints,
          transcription: graded.subs.map((sub) => `${sub.id}) ${sub.transcription || '—'}`).join('; '),
          certainty: worst.certainty,
          comment,
          confidence: weightedConfidence(
            graded.subs.map((sub) => ({ weight: sub.max_points, confidence: sub.confidence }))
          ),
          sub_items: graded.subs,
        });
        continue;
      }

      unsound = true;
    }

    byNumber.set(number, {
      task_number: number,
      points,
      transcription,
      certainty,
      comment,
      confidence: deriveConfidence({ transcription, points, certainty }),
    });
  }

  // Zadanie z klucza, którego model nie oddał w ogóle, nie znika z rozliczenia: uczeń nie dostał za
  // nie punktów, więc praca nie może być w tym miejscu w pełni pewna.
  for (const [number, spec] of specs) {
    if (byNumber.has(number)) continue;

    const subs: GradedSubItem[] | undefined =
      spec.subs.length > 0
        ? spec.subs.map((sub) => ({
            id: sub.id,
            transcription: '',
            points: 0,
            max_points: sub.maxPoints,
            certainty: 'missing_evidence' as TaskCertainty,
            confidence: CERTAINTY_CONFIDENCE.missing_evidence,
          }))
        : undefined;

    byNumber.set(number, {
      task_number: number,
      points: 0,
      transcription: '',
      certainty: 'missing_evidence',
      comment: 'AI nie zwróciło tego zadania.',
      confidence: CERTAINTY_CONFIDENCE.missing_evidence,
      ...(subs ? { sub_items: subs } : {}),
    });
  }

  const tasks = [...byNumber.values()].sort((a, b) => a.task_number - b.task_number);
  if (tasks.length === 0) {
    throw new Error('AI returned no gradable tasks');
  }

  const totalScore = roundPoints(tasks.reduce((sum, task) => sum + task.points, 0));
  const paper = derivePaperConfidence(tasks, specs);

  return {
    confidence_score: unsound ? Math.min(paper, UNSOUND_RESULT_CAP) : paper,
    total_score: totalScore,
    tasks,
  };
}

/**
 * Leniwa inicjalizacja klienta Anthropic (współdzielony per moduł)
 */
let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

/**
 * Wywołanie Claude (Anthropic) - używane dla FAST i PREMIUM
 * Z prompt caching: system jako tablica bloków, klucz odpowiedzi oznaczony cache_control
 */
async function callClaude(imagePath: string, answerKey: any, tier: ModelTier = 'premium'): Promise<AIGradingResult> {
  const anthropic = getAnthropicClient();

  // Przeczytaj obraz jako base64
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');

  const systemPrompt = buildSystemPrompt();
  const answerKeyBlock = buildAnswerKeyBlock(answerKey);

  const model = MODELS[tier].model;

  const message = await anthropic.messages.parse({
    model: model,
    // Transkrypt do każdego zadania i do każdego podpunktu dokłada output tokenów, a ucięta
    // odpowiedź jest poniżej błędem — limit musi wystarczyć na długi klucz z podpunktami.
    max_tokens: 8000,
    system: [
      {
        type: 'text',
        text: systemPrompt,
      },
      {
        type: 'text',
        text: answerKeyBlock,
        cache_control: { type: 'ephemeral' },
      },
    ],
    output_config: {
      format: jsonSchemaOutputFormat(GRADING_OUTPUT_SCHEMA),
    },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: base64Image,
            },
          },
          {
            type: 'text',
            text: 'Oceń tę pracę ucznia według klucza odpowiedzi podanego powyżej.',
          },
        ],
      },
    ],
  });

  // Logowanie użycia cache
  const usage = message.usage;
  console.log(
    `📊 Claude usage: input=${usage.input_tokens}, cache_read=${usage.cache_read_input_tokens || 0}, cache_create=${usage.cache_creation_input_tokens || 0}, output=${usage.output_tokens}, model=${model}, tier=${tier}`
  );

  if (message.stop_reason === 'max_tokens') {
    throw new Error(
      `Claude response truncated at max_tokens (output_tokens: ${message.usage.output_tokens})`
    );
  }

  const parsed = message.parsed_output;
  if (!parsed || !validateModelOutput(parsed)) {
    console.error('❌ Claude output does not match grading schema:', JSON.stringify(parsed));
    throw new Error('Claude returned output that does not match the grading schema');
  }

  return finalizeGradingOutput(parsed, answerKey);
}

/**
 * Wywołanie GPT-4o (OpenAI) - fallback
 */
async function callGPT4o(imagePath: string, answerKey: any): Promise<AIGradingResult> {
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(answerKey);

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${base64Image}`,
            },
          },
        ],
      },
    ],
    response_format: { type: 'json_object' },
    // Ten sam kształt odpowiedzi co w ścieżce głównej, więc i tu podpunkty potrzebują zapasu.
    max_tokens: 4000,
  });

  const responseText = completion.choices[0].message.content || '{}';

  // Ten fallback nie miał nigdy walidacji, a odpowiada tekstem, nie schematem wymuszonym przez API.
  // Bez niej byle jaki JSON przechodził dalej jako prawomocna ocena.
  let raw: unknown;
  try {
    raw = JSON.parse(responseText);
  } catch {
    throw new Error('GPT-4o returned response that is not valid JSON');
  }

  if (!validateModelOutput(raw)) {
    console.error('❌ GPT-4o output does not match grading schema:', responseText);
    throw new Error('GPT-4o returned output that does not match the grading schema');
  }

  return finalizeGradingOutput(raw, answerKey);
}

/**
 * GŁÓWNA FUNKCJA: Hybrydowy router z automatyczną eskalacją
 *
 * Logika:
 * 1. Wywołaj model fast (Claude Haiku) — on oddaje punkty, transkrypty i etykiety, bez liczby pewności
 * 2. Wylicz confidence_score z etykiet, ważąc zadania ich maksymalną punktacją
 * 3. Jeśli < 75 → eskaluj do premium (Claude Sonnet)
 * 4. Przy błędzie wywołania → premium, a GPT-4o jako ostatnia deska ratunku
 * 5. Zwróć ostateczny wynik
 */
export async function gradeWithHybridAI(
  imagePath: string,
  answerKey: any
): Promise<{ result: AIGradingResult; model_used: string; escalated: boolean }> {
  console.log('🤖 Starting hybrid AI grading...');

  let result: AIGradingResult;
  let modelUsed = MODELS.fast.model;
  let escalated = false;

  try {
    // FAZA 1: Spróbuj z fast model (Claude Haiku)
    console.log(`📡 Calling ${MODELS.fast.model} (fast tier)...`);
    result = await callClaude(imagePath, answerKey, 'fast');

    console.log(`📊 Confidence score from ${MODELS.fast.model}: ${result.confidence_score}`);

    // FAZA 2: Sprawdź wyliczoną pewność
    if (result.confidence_score < CONFIDENCE_THRESHOLD) {
      console.log(`⚠️ Derived confidence ${result.confidence_score} < ${CONFIDENCE_THRESHOLD} — shaky: ${shakyTasks(result)}`);
      console.log(`🔄 Escalating to premium model: ${MODELS.premium.model}...`);

      try {
        // Eskaluj do Claude Sonnet
        const premiumResult = await callClaude(imagePath, answerKey, 'premium');

        console.log(`📊 Confidence score from ${MODELS.premium.model}: ${premiumResult.confidence_score}`);

        // Użyj wyniku z premium modelu
        result = premiumResult;
        modelUsed = MODELS.premium.model;
        escalated = true;

        console.log('✅ Escalation successful, using premium result');
      } catch (escalationError) {
        console.error('❌ Premium model failed:', escalationError);
        console.log('⚠️ Falling back to fast model result');
        // Zostań przy wyniku z fast modelu
      }
    } else {
      console.log(`✅ High confidence (${result.confidence_score} >= ${CONFIDENCE_THRESHOLD}), using fast model result`);
    }
  } catch (fastError) {
    console.error('❌ Fast model (Claude Haiku) failed:', fastError);

    // FALLBACK: Spróbuj Claude Sonnet jako backup
    try {
      console.log('🔄 Trying premium model as fallback...');
      result = await callClaude(imagePath, answerKey, 'premium');
      modelUsed = MODELS.premium.model;
      escalated = true;
      console.log('✅ Premium fallback successful');
    } catch (claudeError) {
      console.error('❌ Premium model (Claude Sonnet) also failed:', claudeError);

      // LAST RESORT: GPT-4o
      console.log('🔄 Trying GPT-4o as last resort...');
      result = await callGPT4o(imagePath, answerKey);
      modelUsed = 'gpt-4o';
      escalated = true;
      console.log('✅ GPT-4o fallback successful');
    }
  }

  // Walidacja wyniku. Zera są tu uczciwymi wartościami: pusta kartka ma zero punktów i zero pewności
  // do ustalenia, a dawniejszy test na „!result.x" zamieniał ją w uszkodzoną odpowiedź, więc taka
  // praca była wyrzucana, eskalowana i powtarzana w kółko.
  if (
    !Number.isFinite(result.confidence_score) ||
    !Number.isFinite(result.total_score) ||
    !Array.isArray(result.tasks) ||
    result.tasks.length === 0
  ) {
    throw new Error('Invalid AI response structure');
  }

  return {
    result,
    model_used: modelUsed,
    escalated,
  };
}

/**
 * Waliduje SUROWĄ odpowiedź modelu. Nie ma w niej pola pewności — tego numeru model nie wydaje i nie
 * może go zepsuć. Zera są poprawne: pusta kartka to zero punktów.
 */
function validateModelOutput(raw: unknown): raw is ModelGradingOutput {
  if (typeof raw !== 'object' || raw === null) return false;

  const candidate = raw as Record<string, unknown>;
  const tasks = candidate.tasks;

  if (typeof candidate.total_score !== 'number' || !Number.isFinite(candidate.total_score)) return false;
  if (!Array.isArray(tasks) || tasks.length === 0) return false;

  return tasks.every((task: any) => {
    if (typeof task !== 'object' || task === null) return false;

    const taskRowOk =
      Number.isInteger(Number(task.task_number)) &&
      typeof task.transcription === 'string' &&
      typeof task.points === 'number' &&
      Number.isFinite(task.points) &&
      isCertainty(task.certainty) &&
      typeof task.comment === 'string';

    if (!taskRowOk) return false;

    // Brak `sub_items` jest dozwolony: o tym, czy zadanie ma podpunkty, decyduje klucz, a ten
    // walidator klucza nie widzi. Nieobecną strukturę rozstrzyga finalizeGradingOutput.
    const subs = task.sub_items;
    if (subs === undefined || subs === null) return true;
    if (!Array.isArray(subs)) return false;

    return subs.every(
      (sub: any) =>
        !!sub &&
        typeof sub === 'object' &&
        typeof sub.id === 'string' &&
        sub.id.trim() !== '' &&
        typeof sub.transcription === 'string' &&
        typeof sub.points === 'number' &&
        Number.isFinite(sub.points) &&
        isCertainty(sub.certainty)
    );
  });
}

// ============================================
// ROZPOZNANIE WARIANTU ARKUSZA (klasyfikacja, nie ocena)
// ============================================

/**
 * Wariant do rozpoznania: nazwa, którą zna nauczyciel, i jej zamrożony klucz. Kolejność musi być
 * stabilna w obrębie sesji, bo to z niej powstaje prefiks cache'a między kolejnymi kartkami.
 */
export interface VariantInput {
  name: string;
  answerKey: any;
}

/**
 * Nazwa wariantu sprowadzona do tego, co ją rozróżnia. Model zwraca „Grupa B", „B", „Wariant B."
 * zależnie od kartki, a ścisłe porównanie co do znaku wysyłało wtedy pracę do kosza. Odcinamy słowo
 * porządkowe, interpunkcję i wielkie litery — zostaje sam identyfikator.
 */
export function normalizeVariantName(raw: string): string {
  return raw
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^["'`„”]+|["'`„”]+$/g, '')
    .replace(/^(?:grupa|wariant|arkusz|wersja|variant|version)\s*[-.:]?\s*/, '')
    .replace(/[^a-z0-9ąćęłńóśźż]/g, '');
}

/**
 * Dowolna nazwa — z odpowiedzi modelu, z żądania nauczyciela albo z kolumny `variant_name` — na
 * wariant z tej listy. Null oznacza „nie da się wskazać jednoznacznie", a takiej pracy nie oceniamy:
 * punkty wyszłyby z klucza, którego uczeń mógł nie mieć w ręku.
 */
export function variantResolver<T extends { name: string }>(variants: readonly T[]): (name: unknown) => T | null {
  const byExact = new Map<string, T>();
  // null = pod tym znormalizowanym kluczem kryje się więcej niż jeden wariant, więc nie zgadujemy
  const byLoose = new Map<string, T | null>();

  for (const variant of variants) {
    byExact.set(variant.name.trim().toLocaleLowerCase(), variant);

    const loose = normalizeVariantName(variant.name);
    if (loose) byLoose.set(loose, byLoose.has(loose) ? null : variant);
  }

  return (name: unknown): T | null => {
    if (typeof name !== 'string') return null;

    const trimmed = name.trim();
    const exact = byExact.get(trimmed.toLocaleLowerCase());
    if (exact) return exact;

    const loose = normalizeVariantName(trimmed);
    return loose ? byLoose.get(loose) ?? null : null;
  };
}

export type VariantDetection =
  | { ok: true; variant: string; confidence: number }
  /**
   * 'unresolved' = model nie rozstrzygnął (za niska pewność albo nazwa spoza listy);
   * 'api_error' = samo wywołanie padło i następny /process powinien spróbować ponownie.
   */
  | { ok: false; reason: 'unresolved' | 'api_error'; message: string };

/**
 * Poniżej tej pewności praca nie jest oceniana wcale. Błędny wariant to nie „gorsza nota", tylko klucz
 * z innymi zadaniami i innym mianownikiem, czyli wynik nie do pary, którego nikt nie zauważy. Barierę
 * stawiamy więc wyżej niż próg eskalacji oceny (75) — tu alternatywą jest jedno kliknięcie nauczyciela.
 */
export const MIN_VARIANT_CONFIDENCE = 85;

const VARIANT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    variant: { type: 'string', description: 'Dokładnie jedna z nazw wariantów podanych na liście dostępnych' },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
  },
  required: ['variant', 'confidence'],
  additionalProperties: false,
} as const;

/**
 * Prompt osobny od oceniającego celowo: model ma rozstrzygnąć, który arkusz trafił do ucznia, a nie
 * sprawdzić odpowiedzi. Inaczej pewność rozpoznania zjeżdżałaby z tego, czy uczeń napisał dobrze.
 * Podstawa porównania jest tylko taka, jaką niesie klucz (numeracja, punkty, poprawne odpowiedzi),
 * więc to wydrukowane na kartce oznaczenie wariantu jest pierwszym i najmocniejszym dowodem.
 */
function buildVariantSystemPrompt(variants: VariantInput[]): string {
  const names = variants.map((variant) => `"${variant.name}"`).join(', ');

  return `Przed Tobą zanonimizowana kartka sprawdzianu. Ten sam sprawdzian miał kilka wariantów.

Dostępne warianty: ${names}.

Zasady:
- Najpierw poszukaj na kartce wydrukowanego oznaczenia wariantu, np. „Grupa A", „Grupa B", „Wariant 2", „Wersja B". Jeśli jest czytelne, rozstrzyga samo — przełóż je tylko na dokładną nazwę z listy powyżej.
- Oznaczenia może na kartce nie być (urwane, zasłonięte, zapisane gdzie indziej). Wtedy porównuj to, co klucz realnie niesie: liczbę zadań, ich numerację, punktację i poprawne odpowiedzi. Nie wymagaj treści poleceń — klucz jej nie zawiera.
- Nie oceniaj odpowiedzi ucznia i nie przyznawaj punktów.
- Pewność ('confidence') odnosi się wyłącznie do rozpoznania wariantu.
- Pewność poniżej ${MIN_VARIANT_CONFIDENCE} podaj tylko wtedy, gdy kartka jest nieczytelna albo naprawdę pasuje do więcej niż jednego wariantu. Czysty, cały skan z czytelnym oznaczeniem to wysoka pewność.
- W polu 'variant' zwróć dokładnie jedną nazwę z listy powyżej, bez dodatkowych słów.

KRYTYCZNE: Zwróć wyłącznie surowy obiekt JSON. NIE owijaj kodu w bloki markdown typu \`\`\`json \`\`\`. Odpowiedź musi zaczynać się od { i kończyć na }. Żadnego dodatkowego tekstu.`;
}

/**
 * Wszystkie klucze wariantów w jeden blok. To prefiks cache'owany między kartkami tej samej sesji —
 * przy dwóch lub trzech wariantach przekracza minimalny rozmiar cache'a Haiku, więc tu (w odróżnieniu
 * od jednowariantowego promptu oceniającego, gdzie prefiks miał 583-763 tokeny) cache realnie działa.
 */
function buildVariantsBlock(variants: VariantInput[]): string {
  return variants.map((variant) => `**Wariant: ${variant.name}**\n${buildAnswerKeyBlock(variant.answerKey)}`).join('\n');
}

/**
 * Klasyfikacja jednej kartki na tle wariantów tej samej sesji. Wyłącznie fast tier i bez fallbacku:
 * droższy model podniósłby pewność, ale i tak skończyłoby się kliknięciem nauczyciela, a drugie pełne
 * wywołanie z tym samym obrazem to podwójna opłata za tę samą czynność.
 */
export async function detectVariantFromImage(imagePath: string, variants: VariantInput[]): Promise<VariantDetection> {
  if (variants.length === 0) {
    return { ok: false, reason: 'unresolved', message: 'Sesja nie ma żadnego wariantu do porównania' };
  }

  let parsed: { variant?: string; confidence?: number } | null;

  try {
    const anthropic = getAnthropicClient();
    const base64Image = fs.readFileSync(imagePath).toString('base64');

    const message = await anthropic.messages.parse({
      model: MODELS.fast.model,
      max_tokens: 300,
      system: [
        { type: 'text', text: buildVariantSystemPrompt(variants) },
        { type: 'text', text: buildVariantsBlock(variants), cache_control: { type: 'ephemeral' } },
      ],
      output_config: {
        format: jsonSchemaOutputFormat(VARIANT_OUTPUT_SCHEMA),
      },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
            { type: 'text', text: 'Który wariant tego sprawdzianu znajduje się na tej kartce?' },
          ],
        },
      ],
    });

    console.log(
      `🔎 Variant detection usage: input=${message.usage.input_tokens}, cache_read=${
        message.usage.cache_read_input_tokens || 0
      }, output=${message.usage.output_tokens}`
    );

    if (message.stop_reason === 'max_tokens') {
      return { ok: false, reason: 'api_error', message: 'Model urwał odpowiedź w trakcie rozpoznawania wariantu' };
    }

    parsed = message.parsed_output as { variant?: string; confidence?: number } | null;
  } catch (error) {
    console.error('❌ Variant detection call failed:', error);
    return { ok: false, reason: 'api_error', message: 'Wywołanie rozpoznania wariantu nie powiodło się' };
  }

  if (!parsed || typeof parsed.variant !== 'string' || typeof parsed.confidence !== 'number') {
    return { ok: false, reason: 'unresolved', message: 'Model nie zwrócił nazwy wariantu' };
  }

  // Nazwy od modelu nigdy nie zapisujemy w bazie wprost: musi to być jeden z wariantów tej sesji,
  // inaczej cała ocena liczona by była z klucza, którego w sesji nie ma. Jednocześnie model oddaje
  // nazwę tak, jak ją zobaczył na kartce („Grupa B", „b"), a nie jak mu ją podaliśmy, więc porównanie
  // jest znormalizowane, ale jednoznaczne — wariant o tym samym szkicu nazwy nie istnieje.
  const match = variantResolver(variants)(parsed.variant);

  if (!match) {
    console.warn('⚠️ Variant detection returned an unmatchable name:', parsed.variant);
    return { ok: false, reason: 'unresolved', message: `Model podał nazwę niepasującą do żadnego wariantu: ${parsed.variant.trim()}` };
  }

  if (parsed.confidence < MIN_VARIANT_CONFIDENCE) {
    return {
      ok: false,
      reason: 'unresolved',
      message: `Pewność rozpoznania ${parsed.confidence}%, a wymagamy co najmniej ${MIN_VARIANT_CONFIDENCE}%`,
    };
  }

  return { ok: true, variant: match.name, confidence: parsed.confidence };
}
