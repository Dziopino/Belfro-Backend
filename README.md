# Backend Belfero

Express 4 + Prisma 5.22 + PostgreSQL. Oddaje REST pod `/api/**`, serwuje `uploads/` z dysku i woła
Anthropic przy ocenianiu prac. Domyślnie nasłuchuje na `:3000`.

## Skrypty

| polecenie | co robi |
|---|---|
| `npm run dev` | `ts-node-dev --respawn --transpile-only src/server.ts` — restart po każdej zmianie |
| `npm run build` | `tsc` do `dist/` |
| `npm start` | `node dist/server.js` — wersja po buildzie |
| `npm run prisma:generate` | klient Prisma (trzeba powtórzyć po zmianie `schema.prisma`) |
| `npm run prisma:migrate` | `prisma migrate dev` — nowa migracja z roboczej zmiany schematu |
| `npm run prisma:studio` | podgląd bazy w przeglądarce |

Migracje produkcyjne nakładasz `npx prisma migrate deploy`, a stan sprawdzasz
`npx prisma migrate status`. W `prisma/migrations/` leży szesnaście migracji, najstarsza
`20261009204524_init`, najnowsza `20261020120000_account_kind_default_private`.

Nazwa `20261011025216_init` myli: to nie drugi init, tylko zwykła migracja przyrostowa (dokłada
`grade_thresholds` i kolumnę `grade_threshold_id`). Kolejność po znacznikach czasu jest poprawna,
więc `migrate deploy` przechodzi przez nią bez kolizji.

Uwaga z praktyki: `npx prisma generate` potrafi wyrzucić `EPERM` na `query_engine-windows.dll.node`,
gdy serwer dev trzyma bibliotekę w pamięci. To nie jest błąd schematu — wystarczy zamknąć `npm run dev`.

## Zmienne środowiskowe (`backend/.env`)

Nazwy poniżej to komplet, którego kod faktycznie szuka (`grep process.env` po `src/`).
Wartości są w `backend/.env`; tutaj ich nie zamieszczaj ani nie kopiuj.

| nazwa | domyślna | gdzie | po co |
|---|---|---|---|
| `PORT` | `3000` | `src/server.ts:17` | nasłuch HTTP |
| `FRONTEND_URL` | `http://localhost:5173` | `server.ts:21`, `authController.ts:59,434` | dozwolony origin CORS **i** adres linków w mailach |
| `NODE_ENV` | `development` | `server.ts:52`, `turnstileService.ts:31` | przy `production` bramka Turnstile jest wymagana |
| `DATABASE_URL` | brak | `prisma/schema.prisma:10` | PostgreSQL; bez niej nic nie startuje |
| `JWT_SECRET` | **jest twardy zapasik** | `src/utils/jwt.ts:3` | podpis tokenu — patrz ostrzeżenie niżej |
| `RESEND_API_KEY` | brak | `authController.ts:14` | maile z linkiem potwierdzenia i resetu hasła |
| `ANTHROPIC_API_KEY` | brak | `aiGradingService.ts:605` | ocena prac; jej brak = brak oceniania |
| `OPENAI_API_KEY` | `''` | `src/config/openai.ts:5` | pozostałość po pierwszym dostawcy AI; konfiguracja jest czytana, ale żadna obecna ścieżka oceniania z niej nie korzysta |
| `TURNSTILE_SITE_KEY` | brak | `turnstileService.ts:35` | klucz publiczny widgetu antybotowego |
| `TURNSTILE_SECRET_KEY` | brak | `turnstileService.ts:40` | sekret do weryfikacji tokenu po stronie serwera |
| `SMS_PROVIDER` | `log` | `smsService.ts:270` | `log` nic nie wysyła, `smsapi` / `serwersms` / `hostedsms` dzwonią do **płatnej** bramki |
| `SMS_SENDER_NAME` | `belfro.pl` | `smsService.ts:41` | nadpis widoczny w SMS-ie |
| `SMSAPI_TOKEN` | brak | `smsService.ts:133` | dla `SMS_PROVIDER=smsapi` |
| `SERWERSMS_API_KEY`, `SERWERSMS_USERNAME` | brak | `smsService.ts:168,173` | dla `SMS_PROVIDER=serwersms` |
| `SMS_HOSTEDSMS_EMAIL`, `SMS_HOSTEDSMS_PASSWORD` | brak | `smsService.ts:211,216` | dla `SMS_PROVIDER=hostedsms` |
| `PAYMENTS_ENABLED` | dowolne ≠ `true` | `walletController.ts:37` | tylko literal `true` pokazuje katalog płatności w UI |

**`JWT_SECRET` ma zapasik wpisany w kodzie** (`jwt.ts:3`). Jeśli przy wdrożeniu zapomnisz go ustawić,
produkcja podpisze tokeny ogólnie znanym sekretem i każdy będzie mógł sobie spreparować sesję.
To jest sprawdzone czytaniem kodu, nie testem ataku.

## Dwa rodzaje konta

Konto rozstrzyga, **czy wolno nam w ogóle trzymać imiona i nazwiska uczniów**. Szyfrowanie nie jest
podstawą prawną do przechowywania danych osobowych, a serwera nie obchodzi, jakim kluczem nauczyciel
zaszyfrował nazwisko — więc u konta bez umowy ze szkołą nazwisko nie może powstać nawet jako blob.

| konto | `User.account_kind` | lista uczniów | co leży w `students` |
|---|---|---|---|
| nauczyciel prywatny | `private` (domyślna, `schema.prisma:38`) | `roster_mode = 'numbered'` | tylko jawny `journal_number Int?` (`:137`), trzy kolumny szyfrowane są NULL-ami |
| szkoła (umowa powierzenia) | `school` | `roster_mode = 'named'` (`:104`) | `encrypted_first_name`, `encrypted_last_name`, `encrypted_number` (`:128-130`) |

Domyślnie `private`, bo to tryb, który nie wymaga umowy ze szkołą, więc nie musi być deklarowany; to
przechowywanie nazwisk jest tym, co wymaga jawnego zgłoszenia. Uwaga z praktyki: rejestracja i tak
zawsze zapisuje wybrany typ (`authController.ts:280`), więc ta domyślna wartość wchodzi w grę tylko
przy zapisie pomijającym pole. Konta założone przed 2026-10-19 zostały przy `school`, a w kodzie nie ma
ścieżki, która by je przełączyła.

Pojęcia są w jednym pliku, `src/utils/roster.ts`: `ACCOUNT_KINDS` (`:11`), `ROSTER_MODES` (`:16`),
`MAX_ROSTER_SIZE = 100` (`:19`), `isAccountKind` (`:23`), `rosterModeFor` (`:30`),
`parseRosterNumber` (`:39`), `buildNumberedRoster` (`:47`), `STUDENT_ORDER` (`:60-63`).

Zasady, których nie należy obchodzić:

- **Tryb listy liczony jest z konta, nigdy z ciała requestu** (`rosterModeFor`). Klient, który mógłby
  wybrać tryb, mógłby też wybrać klasę z nazwiskami na koncie prywatnym — a to dokładnie ten stan,
  którego ta granica pilnuje. Dlatego `POST /api/classes` odrzuca `student_count` przy koncie szkolnym
  (`classController.ts:71-78`), a `POST /api/classes/:classId/students` odrzuca nazwisko w klasie
  numerowanej (`studentController.ts:27`, kod `STUDENT_NAMED_FIELDS_FORBIDDEN`).
- **`rosterModeFor` przy nierozpoznanej wartości konta daje `named`, czyli nazwiska** (`roster.ts:30-31`).
  Odwraca więc intencję domyślnej wartości kolumny (`private`). Dziś bez skutku: kolumna jest
  `NOT NULL`, a rejestracja zapisuje jedną z dwóch nazw. Zmiana tego kierunku to decyzja Filipa, nie
  kosmetyka — dotyczy tego, co system zrobi z danymi, których nie rozumie.
- **`accountKind` jest obowiązkowy w rejestracji** (`authController.ts:189`), bez wartości domyślnej —
  brak pola to `ACCOUNT_KIND_INVALID`, nie zgadywanie.
- **Klasa i jej lista powstają w jednej transakcji** (`classController.ts:107-118`); bez tego awaria
  między zapisami zostawiłaby pustą klasę, której nauczyciel nie domyśli i nie rozszerzy.
- **`journal_number` jest jawny celowo** — to klucz porządkowy i jedyna etykieta ucznia, więc musi dać
  się sortować i indeksować bez deszyfracji, której po stronie serwera nie ma i nie będzie. Unikalny
  indeks `@@unique([class_id, journal_number])` (`schema.prisma:149`) daje `STUDENT_NUMBER_TAKEN`
  (`studentController.ts:111-114`); w trybie nazwiskowym kolumna zostaje NULL-em, a wiele NULL-i nie
  kolizjonuje w Postgresie.
- **Porządek listy obsługuje jeden `orderBy` dla obu trybów** (`STUDENT_ORDER`): w numerowanej decyduje
  numer, w nazwiskowej wszystkie numery są NULL-ami, więc realnie sortuje `created_at`. Nie dokładaj
  drugiego sortowania per endpoint.
- **Dokładanie uczniów hurtem to osobna operacja**: `POST /api/classes/:classId/students/append`
  (`routes/classes.ts:35`, `studentController.ts:170-207`) liczy pierwszy wolny numer po najwyższym
  zajętym i pilnuje `MAX_ROSTER_SIZE`.
- **`PATCH /api/account` nie przyjmuje `account_kind`.** Zmiana typu konta to decyzja prawna z
  konsekwencjami dla już zapisanych danych, nie ustawienie w profilu.

## Sesja sprawdzania, grupy i warianty

Sesja jest zamrożonym snapshotem, nie widokiem na bieżące dane. Zmraża cztery rzeczy naraz: nazwę
(`schema.prisma:164`, przepisana z nazwy klucza przy tworzeniu), treść klucza (`:167` — dlatego
`answer_key_id` z `:173` jest tylko proweniencją), progi ocen (`:170`) i skład grup
(`grading_session_groups`, `:222`). Wiersz grupy celowo nie ma relacji do klasy ani do ucznia:
późniejsza edycja klucza w bibliotece albo zmiana składu klasy nie może przerobić już sprawdzonych prac.

Tryb przydziału to decyzja sesji, nie konta. `group_assignment_mode` (`schema.prisma:183`) jest
snapshotem, bo ustawienie konta zmienia się dowolnie, a utworzona sesja musi zostać taką, jaka była:

- `manual` — nauczyciel przypisał uczniów do grup, członkostwa leżą w `grading_session_groups`.
- `ai` — nikt nie przydzielał, wariant pracy rozpoznaje model z jej treści, a definicje wariantów
  sesja trzyma w `answer_key_variants` (`:189`). Taka sesja nie ma wierszy grup, więc jej mianownikiem
  brakujących prac jest „klasa minus nieobecni", a nauczyciel nie płaci za klasyfikację, której wariant
  i tak znałby ze swojej listy (`frozenVariantsFor`, `gradingController.ts:613-619`).

Reguły, których nie należy obchodzić:

- **Wiersz powstaje dla KAŻDEGO wariantu klucza, także pustego** (`parseSessionGroups`,
  `gradingController.ts:261-276`). Grupa bez uczniów nie jest dekoracją: gdy napisze ją uczeń zdjęty
  później z nieobecności, przydział szuka jej w wierszach sesji — bez wiersza nie ma czym sprawdzić
  tego arkusza. `position` bierze kolejność wariantów z klucza, więc nauczyciel widzi grupy tak samo
  w kreatorze, w kolejce, w historii i w PDF.
- **Klient niesie tylko przydział, klucz grupy składa serwer** (`:263-265`). Żądanie podaje
  `{name, student_ids}`, a treść klucza pochodzi z wariantu biblioteki — inaczej frontend mógłby
  podsunąć pod nazwę grupy cudzy klucz i własny mianownik punktów. Stąd `GROUPS_REQUIRE_LIBRARY_KEY`
  (`:302`) i `ANSWER_KEY_HAS_NO_GROUPS` (`:310`): bez klucza z biblioteki sesji grupowej nie ma.
- **Listy uczniów nie mogą się przenikać, a cudzy UUID jest odrzucany** (`:267-268`) — ten sam uczeń
  w dwóch grupach to dwa wyniki, a uczeń spoza klasy zawyżyłby mianownik „brak pracy".
- **Mianownik brakujących prac to unia grup** (`groupPopulationIds:649`), nie liczba uczniów klasy ani
  suma wierszy — uczeń wpisany do dwóch grup liczy się raz. `countMissingStudents:663` odejmuje
  nieobecnych i tych, którzy już mają pracę; wynik dodatni daje status `awaiting_works` (`:989`, `:1667`).
- **Nieobecności i skład grup zapisuje jedno żądanie** (`parseSessionGroupsPatch:432`,
  `updateGradingSession:877`). Dwa żądania zostawiałyby stan pośredni, w którym lista obecności
  rozmija się z przydziałem, a na przydziale nauczyciel ocenia.
- **Stan sesji to pięć wartości** (`schema.prisma:194`): `in_progress` (`gradingController.ts:842`),
  `processing` (`:1445`), `completed` i `awaiting_works` (`:1667`) oraz `archived`. `awaiting_works` to
  nie awaria — to „AI sprawdziło to, co wpłynęło, a w klasie zostały osoby bez pracy i bez nieobecności".
- **Klucz właściwy dla pracy resolveuje jedno miejsce** (`buildAnswerKeyResolver:590`): klucz grupy z
  `grading_session_groups`, a dopiero pod nim klucz sesji (`:602`). Obejście istnieje dla pracy ucznia
  spoza przydziału — dosłanej po zmianie listy — żeby `/process` nigdy nie został bez klucza do
  porównania. Nowy endpoint nie może dorabiać własnego „który to klucz".
- **Jeden `Grade` to jeden plik.** `image_path` jest pojedynczym `String` (`schema.prisma:354`), a
  `/process` czyta z niego dokładnie jeden obraz (`gradingController.ts:1531`). Karta wielostronicowa
  zapada się do ostatniego wgranego skanu — przy 2676x1836 to realny przypadek, nie hipotetyczny.

## Ocenianie AI

- **Model nie podaje liczb.** Pewność pracy wywodzi się z czterech etykiet (`TaskCertainty`,
  `aiGradingService.ts:11`) i ich wag (`CERTAINTY_CONFIDENCE`, `:25-30`); liczbę 0-100 wylicza kod
  (`deriveConfidence:358`, `weightedConfidence:372`). Samodeklaracja bez kryteriów byłaby wróżeniem, a
  waga jest niesymetryczna celowo: „przeczytałem źle" (55) jest gorsze niż „klucz nie rozstrzyga" (80),
  bo w pierwszym punkty ucznia mogą być po prostu pomylone, a w drugim nauczyciel ogląda ten sam tekst.
- **Sumy też nie podaje model.** `total_score` to suma `tasks[].points` policzona w kodzie (`:74-75`), a
  zadanie z podpunktami nie ma nawet pola, w którym model mógłby zapisać sumę kłócącą się z jego własnymi
  wierszami (`:49-53`).
- **Dwie warstwy modelu.** Pewność poniżej 75 eskaluje pracę do droższego modelu (`CONFIDENCE_THRESHOLD`,
  `:185`, sam wybór `:773`); próg wyższy niż ten z UI, bo tu alternatywą jest ponowne wywołanie, a nie
  kliknięcie nauczyciela. Rozpoznanie wariantu ma własny próg 85 (`MIN_VARIANT_CONFIDENCE`, `:953`).
- **Każda praca zostawia ślad decyzji** w `grades.model_used` i `grades.escalated` (`gradingController.ts:1611-1612`)
  — to na ich podstawie `scripts/measure-escalation-rate.ts` liczy realny odsetek eskalacji i koszt strony.

## Saldo stron

Saldem jest `User.pages_current_limit` (`schema.prisma:41`; startowe 350 stron naliczane przy
rejestracji, `authController.ts:281`) plus życiowy licznik `pages_total_processed` (`:42`). Frontend
dostaje obie liczby razem z cennikiem jednym `GET /api/wallet` (`routes/wallet.ts:11`,
`walletController.ts:15`). Katalogów cen w bundlu Reacta nie ma, bo `src/config/pricing.ts` jest ich
**jedynym** miejscem — stawki zmienia się bez przebudowy frontendu. Gdy `PAYMENTS_ENABLED` jest różny
od literału `true`, znika katalog, saldo zostaje (`walletController.ts:37`).

Rozliczenie idzie po wierszu `Grade`, nie po sesji ani po żądaniu:

- `/process` ocenia tylko te prace, które nie mają wyniku (`grades.filter(g => g.final_points ===
  null)`, `gradingController.ts:1423`), więc powtórne żądanie nie przepisuje ocen ani nie nalicza stron.
- Przed startem porównuje `pages_current_limit < pendingCount` i odmawia `PAGE_LIMIT_EXCEEDED` (`:1427-1433`)
  zamiast zacząć, urwać w połowie i kazać płacić za niedokończoną sesję.
- Saldo schodzi o jeden przy zapisie wyniku każdej pracy (`:1617-1622`).

Konsekwencja, o której łatwo zapomnieć: ponowne wgranie skanu temu samemu uczniowi w tej samej sesji
**nie pobiera strony po raz drugi**, ale kasuje oceniony skan. `uploadAndAnonymizeImage` aktualizuje
istniejący wiersz (`:1304-1339`) — nadpisuje `image_path`, zeruje `ai_response` i `confidence_score`,
kasuje plik zastąpiony (`deleteReplacedScan:1054`) — a `final_points` zostawia, bo nie ma go w `data`
przy `update` (`:1317-1325`). Taki wiersz wypada z filtru `:1423`, więc AI już go nie zobaczy i pobrania
nie będzie; znika za to stary, prawidłowo oceniony plik, a w tabeli zostają punkty z niego. Ofiarą jest
więc spójność oceny z materiałem, nie saldo. Bramą przed ponownym wgraniem jest frontend (kolejka nie
pokazuje prac obsłużonych), nie backend — backend takiej bramki nie ma i nie udaje, że ma.

## Pliki na dysku

Ścieżki wyłącznie przez `src/config/paths.ts`: `BACKEND_ROOT`, `UPLOADS_ROOT` (= `backend/uploads/`),
`ANONYMIZED_DIR` (= `backend/uploads/anonymized/`). `absoluteUploadPath()` (`:15-27`) bierze ścieżkę
z kolumny `grades.image_path`, wymaga przedrostka `uploads/` i odcina wyjście z katalogu — stąd
wyjątki `Unexpected stored upload path` i `Stored upload path escapes the uploads directory`.

**Nie używaj `process.cwd()`** do składania ścieżek: dev startuje z katalogu procesu, a `npm start`
z innego i pliki rozjedzie się na dwa miejsca.

Skany uczniów to dane osobowe. Nazwa pliku na dysku to UUID ucznia, więc nazwa pliku **nie jest**
dane osobowe, ale **jest** identyfikatorem — nie loguj ścieżek i nie kopiuj zawartości `uploads/`.

## Błędy

Każdy błąd wychodzi kopertą `{ error, code }`: `error` to zdanie po angielsku dla programisty,
`code` to stabilny identyfikator, po którym frontend tłumaczy wiadomość na polski
(`frontend/src/utils/apiError.ts`). **`code` jest API — nie zmieniaj istniejących kodów i nie
rozpoznawaj ich po treści `error`.** Nowy kod bez wpisu w rejestrze znaczy dla nauczyciela sam ogólnik.

Błędy, których nie złapał `catch` kontrolera, wyłapuje terminalny `src/middleware/errorHandler.ts`
(rejestracja w `server.ts:52`) i też ubiera je w kopertę. Bez niego multer, limit rozmiaru skanu czy
synchroniczny `throw` w middleware wyrzucały klientowi domyślny HTML Expressa razem ze stackiem.
Odrzucone wgrania mają kody `UPLOAD_*` i limity wzięte z `src/config/upload.ts`, nie z literałów.

## Skrypty w `scripts/`

| plik | czy wolno uruchomić |
|---|---|
| `test-orientation.js` | tak, `node scripts/test-orientation.js`; wariant 04 wymaga wcześniejszego `npm run build` |
| `test-scan-enhancement.ts` | tak — sprawdza wzmocnienie skanu i białą ramkę nad nazwiskiem |
| `probe-sub-items.ts` | tak — arytmetyka podpunktów bez modelu, bez bazy i sieci |
| `measure-escalation-rate.ts` | tak, ale **tylko czyta** bazę (liczy `grade.model_used` / `grade.escalated`) |
| `probe-cache-prefix.ts` | **nie bez świadomości kosztu** — woła Anthropic i płaci za tokeny |
| `test-rect-validation.ts` | **nie na żywej bazie** — ostatni przypadek tworzy prawdziwy wiersz `Grade` |
| `reprocess-anonymized.js` | **nie bez poprawki ścieżek** — `SRC_DIR` i `OUT_DIR` (`:31-32`) wskazują `backend/src/uploads/anonymized`, a takiego katalogu nie ma; prawdziwe skany leżą w `backend/uploads/anonymized` (`src/config/paths.ts`). Dziś kończy się `ENOENT` i nic nie nadpisuje; po ewentualnej poprawce wyniki idą do osobnego `anonymized_reprocessed` (`:169`), więc źródeł nie rusza |

## Czego nie uruchamiać „żeby sprawdzić”

- `POST /api/grading/sessions/:id/process` — wydaje saldo nauczyciela i pieniądze Filipa,
- `/api/auth/sms/**` przy `SMS_PROVIDER` innym niż `log` — płatna bramka SMS,
- formularz odzyskiwania hasła na koncie z uczniami — reset podmienia `encryption_salt`, a z nim znika
  klucz E2E do imion i nazwisk wszystkich uczniów tego konta,
- `POST /api/auth/register` i `POST /api/auth/login` — prawdziwe konta i prawdziwe wpisy w bazie.
