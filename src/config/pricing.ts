/*
 * Cennik doładowań konta. Jedyne miejsce, w którym istnieją ceny — klient dostaje je wyłącznie
 * przez GET /api/wallet, dzięki temu stawki nie trafiają do bundla Reacta i zmieniają się bez przebudowy.
 *
 * MODEL KOSZTU STRONY (stan na 2026-10-13, do przeliczenia przy każdej zmianie stawek):
 *   Stawki Anthropic (platform.claude.com/docs/en/docs/about-claude/pricing):
 *     claude-haiku-5-5   $0,10 / MTok wejścia, $0,50 / MTok wyjścia (prompt <= 100k)
 *     claude-sonnet-5-5  $2,00 / MTok wejścia, $10,00 / MTok wyjścia
 *   Tokeny zmierzone backend/scripts/probe-cache-prefix.ts na realnych sesjach:
 *     skan 2676x1836 = 4734 tok. wejścia (najgorszy realny wariant), prefiks (system + klucz) = 583-763
 *     wyjście: przyjęte 900 tok. (komentarze 2-3 zdania na zadanie) — do potwierdzenia w Console > Billing
 *   Sam Haiku: 5497 wejścia + 900 wyjścia = $0,0010
 *   Eskalacja do Soneta dokłada $0,0200; przy 25% prac eskalowanych średnio $0,0050
 *   Błędne wywołania (błąd albo obcięty wynik — strona przepada, bo /process jej nie zwraca): +10%
 *   => $0,0066 * 3,65 PLN/USD = ~0,024 zł za stronę, czyli 2,4 gr
 *
 * Koszt zmienny AI jest więc znikomy; o marży decyduje koszt stały (hosting, baza, SMS, storage)
 * i prowizja płatności. Przykładowo przy 300 zł/miesiąc kosztów stałych:
 *   1 000 stron/miesiąc  -> 0,30 zł/str. kosztu stałego (małe wolumeny nie mogą być tanie)
 *   5 000 stron/miesiąc  -> 0,06 zł/str.
 *   20 000 stron/miesiąc -> 0,015 zł/str.
 * Poniższy cennik jest tak dobrany, żeby nawet najtańszy jednostkowo pakiet (szkolny) zostawiał
 * około siedmiokrotność kosztu AI i pokrywał prowizję 2,9% + 1 zł oraz VAT 23%.
 *
 * Dwie rodziny ofert:
 *   PAGE_PACKS    — doładowanie jednorazowe, strony bez daty ważności. Droższe za stronę, bo
 *                   przychodzi jedna płatność i sama musi pokryć koszt pozyskania klienta.
 *   MONTHLY_PLANS — abonament, ~25-30% taniej za stronę. Płaci się przewidywalnością: stały
 *                   wolumen miesięcznie, jedna prowizja zamiast wielu, a niewykorzystane strony
 *                   przepadają z końcem okresu (breakage realnie podnosi marżę, nie obniża jej).
 *                   Warunek uczciwości: abonament musi wyjść dodatnio nawet w najgorszym
 *                   scenariuszu (100% prac eskalowanych = 0,077 zł/str.):
 *                     150/39 zł   -> 18,03 zł zostaje
 *                     500/109 zł  -> 45,96 zł
 *                     1500/249 zł -> 78,72 zł
 *                     4000/549 zł -> 121,42 zł
 *                   Przy typowych 25% eskalacji marża brutto to 60-66% ceny, czyli tyle samo co
 *                   przy doładowaniach — płacimy nią lojalność klienta, nie wchodzimy w stratę.
 */

export interface PagePack {
  id: string;
  pages: number;
  /** Cena brutto w zł (z VAT) — tyle płaci klient. */
  priceGrossPln: number;
  name: string;
  tagline: string;
  features: string[];
  badge?: 'recommended' | 'best_value';
}

export const CURRENCY = 'PLN';

export const PAGE_PACKS: PagePack[] = [
  {
    id: 'pack-100',
    pages: 100,
    priceGrossPln: 39,
    name: 'Na próbę',
    tagline: 'Kilka sprawdzianów, bez zobowiązań',
    features: [
      '100 stron do sprawdzenia',
      'Strony nie przepadają po miesiącu',
      'Dowolna liczba klas i uczniów',
      'Eksport wyników do PDF',
    ],
  },
  {
    id: 'pack-500',
    pages: 500,
    priceGrossPln: 149,
    name: 'Dla jednego przedmiotu',
    tagline: 'Około dwudziestu sprawdzianów 25-osobowej klasy',
    features: [
      '500 stron do sprawdzenia',
      'Strony nie przepadają po miesiącu',
      'Dowolna liczba klas i uczniów',
      'Eksport wyników do PDF',
    ],
  },
  {
    id: 'pack-1500',
    pages: 1500,
    priceGrossPln: 349,
    name: 'Dla nauczyciela',
    tagline: 'Rok pracy na kilku klasach',
    badge: 'recommended',
    features: [
      '1500 stron do sprawdzenia',
      'Strony nie przepadają po miesiącu',
      'Dowolna liczba klas i uczniów',
      'Dokładniejsze sprawdzanie prac z niską pewnością AI',
      'Eksport wyników do PDF',
    ],
  },
  {
    id: 'pack-4000',
    pages: 4000,
    priceGrossPln: 749,
    name: 'Dla zespołu',
    tagline: 'Zapas na cały rok dla kilku klas',
    features: [
      '4000 stron do sprawdzenia',
      'Strony nie przepadają po miesiącu',
      'Dowolna liczba klas i uczniów',
      'Dokładniejsze sprawdzanie prac z niską pewnością AI',
      'Faktura VAT',
      'Priorytetowe wsparcie',
    ],
  },
  {
    id: 'pack-10000',
    pages: 10000,
    priceGrossPln: 1690,
    name: 'Dla szkoły',
    tagline: 'Wspólne konto dla całego grona pedagogicznego',
    badge: 'best_value',
    features: [
      '10 000 stron do sprawdzenia',
      'Strony nie przepadają po miesiącu',
      'Dowolna liczba klas i uczniów',
      'Dokładniejsze sprawdzanie prac z niską pewnością AI',
      'Faktura VAT',
      'Wsparcie przy wdrożeniu',
    ],
  },
];

/**
 * Abonament miesięczny: taniej za stronę niż doładowanie jednorazowe, ale puli nie przenosimy —
 * z końcem okresu niewykorzystane strony przepadają, a nowy okres startuje od pełnego przydziału.
 */
export interface MonthlyPlan {
  id: string;
  /** Strony przydzielane na każdy okres rozliczeniowy. */
  pagesPerPeriod: number;
  /** Cena brutto w zł (z VAT) za miesiąc. */
  priceGrossPln: number;
  name: string;
  tagline: string;
  features: string[];
  badge?: 'recommended' | 'best_value';
}

export const MONTHLY_PLANS: MonthlyPlan[] = [
  {
    id: 'plan-150',
    pagesPerPeriod: 150,
    priceGrossPln: 39,
    name: 'Jedna klasa',
    tagline: 'Średnio sześć sprawdzianów 25-osobowej klasy miesięcznie',
    features: [
      '150 stron każdego miesiąca',
      'Taniej za stronę niż przy jednorazowym doładowaniu',
      'Niewykorzystane strony przepadają z końcem miesiąca',
      'Rezygnacja w każdej chwili',
      'Eksport wyników do PDF',
    ],
  },
  {
    id: 'plan-500',
    pagesPerPeriod: 500,
    priceGrossPln: 109,
    name: 'Kilka klas',
    tagline: 'Standardowy rok nauczyciela uczącego w kilku klasach',
    badge: 'recommended',
    features: [
      '500 stron każdego miesiąca',
      'Taniej za stronę niż przy jednorazowym doładowaniu',
      'Niewykorzystane strony przepadają z końcem miesiąca',
      'Rezygnacja w każdej chwili',
      'Dokładniejsze sprawdzanie prac z niską pewnością AI',
      'Eksport wyników do PDF',
    ],
  },
  {
    id: 'plan-1500',
    pagesPerPeriod: 1500,
    priceGrossPln: 249,
    name: 'Zespół przedmiotowy',
    tagline: 'Praca kilku nauczycieli na wspólnym koncie',
    features: [
      '1500 stron każdego miesiąca',
      'Taniej za stronę niż przy jednorazowym doładowaniu',
      'Niewykorzystane strony przepadają z końcem miesiąca',
      'Rezygnacja w każdej chwili',
      'Dokładniejsze sprawdzanie prac z niską pewnością AI',
      'Faktura VAT',
    ],
  },
  {
    id: 'plan-4000',
    pagesPerPeriod: 4000,
    priceGrossPln: 549,
    name: 'Cała szkoła',
    tagline: 'Najniższa cena strony w abonamencie',
    badge: 'best_value',
    features: [
      '4000 stron każdego miesiąca',
      'Taniej za stronę niż przy jednorazowym doładowaniu',
      'Niewykorzystane strony przepadają z końcem miesiąca',
      'Rezygnacja w każdej chwili',
      'Dokładniejsze sprawdzanie prac z niską pewnością AI',
      'Faktura VAT',
      'Priorytetowe wsparcie',
    ],
  },
];
