-- Wyjaśnienie, dlaczego wariant pracy nadal nie jest rozstrzygnięty.
--
-- Stan trzyma `variant_source`, ta kolumna niesie tylko zdanie dla nauczyciela. Bez niej jedynym
-- śladem nieudanego rozpoznania był log procesu dev serwera, a nauczyciel zobaczyłby pracę bez
-- wariantu i bez powodu. Tekst zapisujemy ucięty do 300 znaków i kasujemy przy pierwszym
-- rozstrzygnięciu — nie może zalegać przy pracy już sprawdzonej.

-- AlterTable
ALTER TABLE "grades" ADD COLUMN IF NOT EXISTS "variant_note" TEXT;

-- Prace oznaczone przed tą zmianą jako 'unresolved' nie mówią prawdy: starszy kod stawiał ten
-- znacznik także wtedy, gdy samo wywołanie rozpoznania padło, czyli gdy klasyfikacja w ogóle się
-- nie odbyła. Nie da się tego odróżnić po fakcie, więc zwalniamy znacznik wszędzie — następne
-- sprawdzanie sesji rozpozna te kartki od nowa (klasyfikacja nie zdejmuje strony z salda), a praca
-- naprawdę odrzucona wróci do tego samego stanu w tym samym przebiegu.
UPDATE "grades" SET "variant_source" = NULL WHERE "variant_source" = 'unresolved';
