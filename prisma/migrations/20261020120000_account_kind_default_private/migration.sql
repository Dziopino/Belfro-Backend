-- Domyślnym rodzajem konta jest "private": tryb bez umowy ze szkołą jest tym bezpieczniejszym, więc nie
-- wymaga deklaracji, a przechowywanie imion i nazwisk uczniów będzie jej wymagało jawnie.
--
-- To zmiana WYŁĄCZNIE wartości domyślnej kolumny. Żaden istniejący wiersz nie jest dotykany — konta
-- założone wcześniej zostają przy "school" i działają dokładnie tak jak dziś, a ich klasy nadal mają
-- roster_mode = 'named'. Nowe konta i tak dostają account_kind z formularza rejestracji, więc ta
-- domyślna wartość wchodzi w grę tylko przy zapisie pomijającym pole.

ALTER TABLE "users" ALTER COLUMN "account_kind" SET DEFAULT 'private';
