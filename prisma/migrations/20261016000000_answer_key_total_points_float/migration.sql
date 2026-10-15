-- Podpunkty w kluczu odpowiedzi: suma punktów przestaje być liczbą całkowitą.
--
-- Zadanie z podpunktami (a, b, c...) ma `max_points` równe sumie punktów podpunktów, a nauczyciel
-- punktuje je po 0,5 — klasyczny schemat przy czterech porównaniach za 2 punkty. Wtedy suma
-- wariantu bywa niecałkowita (trzy podpunkty po 0,5 to 1,5), a `total_points` było `Int`, więc
-- zapis takiego klucza kończył się błędem Prisma. To nie jest nowa zależność: `normalizeTasks`
-- akceptował ułamkowe `max_points` już wcześniej, tylko nic nie skłaniało do ich wpisywania.
-- Poszeriamy więc obie kolumny na `double precision`. Konwersja jest bezpieczna w obie strony
-- (każde istniejące INT mieści się we FLOAT), żadna wartość nie ginie i żadna nie zmienia zapisu.
--
-- Samych podpunktów tu nie widać: mieszkają w kolumnach `tasks`/`answer_key` typu JSON, które nie
-- mają schematu, więc ani ta migracja, ani żadna przyszła nie jest potrzebna, żeby je zapisać.

-- AlterTable
ALTER TABLE "answer_keys" ALTER COLUMN "total_points" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "answer_key_groups" ALTER COLUMN "total_points" SET DATA TYPE DOUBLE PRECISION;
