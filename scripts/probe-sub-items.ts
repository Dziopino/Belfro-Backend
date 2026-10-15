/*
 * Arytmetyka podpunktów bez wywołania modelu: `finalizeGradingOutput` liczy punkty zadania z sumy
 * jego wierszy, a normalizator klucza pilnuje, żeby stawki tych wierszy dały punktację zadania.
 * Uruchom: npx ts-node --transpile-only scripts/probe-sub-items.ts
 * Nic nie zapisuje w bazie i nie rusza sieci — zmienne środowiskowe podstawiamy dorywczo.
 */
import { finalizeGradingOutput } from '../src/services/aiGradingService';
import { normalizeTasks } from '../src/controllers/answerKeyController';

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`OK   ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

const key = {
  tasks: [
    { id: '1', max_points: 3, correct_answer: '3x + 1', guidelines: '' },
    {
      id: '5',
      max_points: 2,
      correct_answer: '',
      guidelines: '',
      sub_items: [
        { id: 'a', max_points: 0.5, correct_answer: '1' },
        { id: 'b', max_points: 0.5, correct_answer: '2' },
        { id: 'c', max_points: 0.5, correct_answer: '3' },
        { id: 'd', max_points: 0.5, correct_answer: '4' },
      ],
    },
  ],
};

const norm = normalizeTasks(key.tasks);
if ('error' in norm) {
  console.log('FAIL klucz wzorcowy odrzucony przez normalizator — dalej nie ma czego liczyć');
  process.exit(1);
}

check(
  'normalizator: max_points zadania z podpunktami to suma ich stawek',
  norm.tasks[1].max_points === 2,
  `dostałem ${norm.tasks[1].max_points}`
);
check('normalizator: total_points klucza to suma zadań', norm.total_points === 5, `dostałem ${norm.total_points}`);

const sub = (id: string, points: number, certainty = 'certain', transcription = `odpowiedz ${id}`) => ({
  id,
  points,
  certainty,
  transcription,
});

const row = (taskNumber: number, points: number, extra: Record<string, unknown> = {}) => ({
  task_number: taskNumber,
  points,
  transcription: '...',
  certainty: 'certain',
  comment: '...',
  ...extra,
});

const five = (result: ReturnType<typeof finalizeGradingOutput>) =>
  result.tasks.find((task) => task.task_number === 5)!;

// Dwa poprawne podpunkty z czterech dają dwa razy stawkę, a nie pełnię zadania.
const half = finalizeGradingOutput(
  {
    tasks: [
      row(1, 3),
      row(5, 2, {
        sub_items: [
          sub('a', 0.5),
          sub('b', 0.5),
          sub('c', 0, 'missing_evidence', ''),
          sub('d', 0, 'missing_evidence', ''),
        ],
      }),
    ],
  } as any,
  key
);
check('połowa podpunktów to połowa punktów zadania (1 pkt, nie 2)', five(half).points === 1, `dostałem ${five(half).points}`);
check('suma pracy idzie za sumą podpunktów', half.total_score === 4, `dostałem ${half.total_score}`);

// Liczba zbiorcza z odpowiedzi modelu nie ma nic do rzeczy, gdy są wiersze podpunktów.
const inflated = finalizeGradingOutput(
  { tasks: [row(1, 3), row(5, 2, { sub_items: [sub('a', 0.5), sub('b', 0.5), sub('c', 0.5), sub('d', 0)] })] } as any,
  key
);
check('punkty zadania pochodzą z wierszy, nie z deklaracji modelu', five(inflated).points === 1.5, `dostałem ${five(inflated).points}`);

// Podpunkt ponad własną stawkę jest przycinany, a praca oznaczana jako nierzetelna.
const overStake = finalizeGradingOutput(
  { tasks: [row(1, 3), row(5, 2, { sub_items: [sub('a', 0.5), sub('b', 0.5), sub('c', 0.5), sub('d', 2)] })] } as any,
  key
);
check(
  'podpunkt ponad własną stawkę przycięty do stawki',
  five(overStake).sub_items![3].points === 0.5,
  `dostałem ${five(overStake).sub_items![3].points}`
);
check('przycięcie obniża pewność całej pracy do 40', overStake.confidence_score <= 40, `dostałem ${overStake.confidence_score}`);

// Zadanie z podpunktami w kluczu, dla którego model oddał tylko liczbę zbiorczą, nie jest błędne.
const noSubRows = finalizeGradingOutput({ tasks: [row(1, 3), row(5, 2)] } as any, key);
check('brak wierszy podpunktów zachowuje punkty zadania', five(noSubRows).points === 2, `dostałem ${five(noSubRows).points}`);
check('brak wierszy podpunktów obniża pewność do 40', noSubRows.confidence_score <= 40, `dostałem ${noSubRows.confidence_score}`);

// Pominięcie któregoś podpunktu dopełnia go zerem i markinguje nierzetelność.
const skipped = finalizeGradingOutput(
  { tasks: [row(1, 3), row(5, 2, { sub_items: [sub('a', 0.5), sub('b', 0.5), sub('c', 0.5)] })] } as any,
  key
);
check(
  'pominięcie podpunktu dopełnia wiersz zerem',
  five(skipped).sub_items!.length === 4 && five(skipped).sub_items![3].points === 0
);
check('pominięcie podpunktu obniża pewność do 40', skipped.confidence_score <= 40, `dostałem ${skipped.confidence_score}`);

// Podpunkt spoza klucza nie dokłada punktów.
const unknown = finalizeGradingOutput(
  {
    tasks: [row(1, 3), row(5, 2, { sub_items: [sub('a', 0.5), sub('b', 0.5), sub('c', 0.5), sub('d', 0.5), sub('e', 3)] })],
  } as any,
  key
);
check(
  'podpunkt spoza klucza znika z rozliczenia',
  five(unknown).sub_items!.length === 4 && five(unknown).points === 2,
  `dostałem ${five(unknown).points}`
);
check('podpunkt spoza klucza obniża pewność do 40', unknown.confidence_score <= 40, `dostałem ${unknown.confidence_score}`);

// Pewność zadania jest ważona stawkami podpunktów, a pewność pracy — punktacją zadań.
const allCertain = finalizeGradingOutput(
  { tasks: [row(1, 3), row(5, 2, { sub_items: [sub('a', 0.5), sub('b', 0.5), sub('c', 0.5), sub('d', 0.5)] })] } as any,
  key
);
check(
  'wszystko pewne daje 100 na obu poziomach',
  allCertain.confidence_score === 100 && five(allCertain).confidence === 100,
  `praca ${allCertain.confidence_score}, zadanie ${five(allCertain).confidence}`
);

const oneShaky = finalizeGradingOutput(
  {
    tasks: [row(1, 3), row(5, 2, { sub_items: [sub('a', 0.5), sub('b', 0.5), sub('c', 0.5), sub('d', 0.5, 'reading_uncertain')] })],
  } as any,
  key
);
check('jeden niepewny podpunkt obniża zadanie poniżej 100', five(oneShaky).confidence === 89, `dostałem ${five(oneShaky).confidence}`);
check('suma podpunktów nie przesłania pracy', oneShaky.confidence_score === 96, `dostałem ${oneShaky.confidence_score}`);
check(
  'etykieta zadania bierze najgorszy podpunkt',
  five(oneShaky).certainty === 'reading_uncertain',
  `dostałem ${five(oneShaky).certainty}`
);
check(
  'transkrypt zadania składa się z transkryptów podpunktów',
  five(oneShaky).transcription.startsWith('a) ') && five(oneShaky).transcription.includes('d) ')
);

// Punkty bez dowodu na kartce to brak dowodu, nawet z etykietą „pewne”.
const noEvidence = finalizeGradingOutput(
  { tasks: [row(1, 3), row(5, 2, { sub_items: [sub('a', 0.5), sub('b', 0.5), sub('c', 0.5), sub('d', 0.5, 'certain', '')] })] } as any,
  key
);
check(
  'podpunkt z punktami bez transkryptu dostaje pewność braku dowodu',
  five(noEvidence).sub_items![3].confidence === 30,
  `dostałem ${five(noEvidence).sub_items![3].confidence}`
);

// Walidacja klucza: litery muszą się różnić, stawka musi być dodatnia, a ich liczba ograniczona.
const dup = normalizeTasks([
  {
    id: '1',
    max_points: 1,
    correct_answer: 'x',
    sub_items: [
      { id: 'a', max_points: 1, correct_answer: '1' },
      { id: 'A', max_points: 1, correct_answer: '2' },
    ],
  },
]);
check('duplikat litery w jednym zadaniu odrzucony', 'error' in dup && (dup as any).code === 'ANSWER_KEY_SUB_ITEM_ID_DUPLICATED');

const zeroStake = normalizeTasks([
  { id: '1', max_points: 1, correct_answer: 'x', sub_items: [{ id: 'a', max_points: 0, correct_answer: '1' }] },
]);
check('podpunkt ze stawką zero odrzucony', 'error' in zeroStake && (zeroStake as any).code === 'ANSWER_KEY_SUB_ITEM_INVALID');

const tooMany = normalizeTasks([
  {
    id: '1',
    max_points: 21,
    correct_answer: 'x',
    sub_items: Array.from({ length: 21 }, (_, i) => ({
      id: String.fromCharCode(97 + i),
      max_points: 1,
      correct_answer: String(i),
    })),
  },
]);
check('dwudziesty pierwszy podpunkt odrzucony', 'error' in tooMany);

const notArray = normalizeTasks([{ id: '1', max_points: 1, correct_answer: 'x', sub_items: 'abc' }]);
check('sub_items niebędące tablicą odrzucone', 'error' in notArray);

const emptyArray = normalizeTasks([{ id: '1', max_points: 4, correct_answer: 'x', sub_items: [] }]);
check(
  'pusta tablica podpunktów to punktacja zbiorcza',
  !('error' in emptyArray) && emptyArray.tasks[0].max_points === 4 && emptyArray.tasks[0].sub_items === undefined
);

const legacyTask = normalizeTasks([{ id: '1', max_points: 4, correct_answer: 'x' }]);
check('zadanie bez podpunktów zachowuje wpisaną punktację', !('error' in legacyTask) && legacyTask.tasks[0].max_points === 4);

console.log(failures === 0 ? '\nWszystkie sprawdzenia przeszły' : `\n${failures} sprawdzeń padło`);
process.exit(failures === 0 ? 0 : 1);
