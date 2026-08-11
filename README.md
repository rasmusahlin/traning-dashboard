# Träningsdashboard

Personlig träningsdashboard för löpning, styrketräning och vandring. Appen är statisk HTML/CSS/JavaScript, tolkar Garmin FIT-filer i webbläsaren och använder Supabase (PostgreSQL) för lagring.

## Kör lokalt

Ingen installation eller byggprocess behövs.

```bash
python3 -m http.server 8000
```

Öppna `http://localhost:8000/`. Utan en giltig Supabase-session visas inloggningsvyn och ingen träningsdata hämtas. Använd syntetisk data vid utveckling och test.

## Kontroller

```bash
node --test
node --check js/security.js && node --check js/data-utils.js && node --check js/db.js && node --check js/fit-parser.js && node --check js/plan.js
```

## Säker Supabase-installation

Frontendens anon-nyckel är publik av design. Dataskyddet måste därför ligga i Supabase Auth och Row Level Security (RLS). `schema.sql` är fail-closed: det skapar tabeller, aktiverar RLS och återkallar anon-åtkomst men skapar inga användarpolicies.

Gör hela följande sekvens innan appen används mot databasen:

1. Kör `schema.sql` i Supabase SQL Editor. Appen ska fortfarande sakna tabellåtkomst.
2. Skapa eller bjud in ägaren i Supabase Auth.
3. Kopiera `supabase/migrations/001_owner_rls_auth.sql` till SQL Editor. Ersätt ägarens e-postplaceholder endast i den privata editorkopian; checka aldrig in den verkliga adressen.
4. Kör migration 001. Den lägger till ägarskap, backfill, authenticated-grants och RLS-policies för aktiviteter, laps, splits, tidsserier och kostloggar.
5. Kör `supabase/migrations/002_training_plan_logs.sql`. Tabellen har egen ägarpolicy och ingen anon-åtkomst och krävs för plansidans tvåvägssynk.
6. Kör `supabase/migrations/003_atomic_activity_import.sql`. Den lägger till datakontroller, filfingeravtryck och den atomiska importfunktionen. Om en FIT-import misslyckas ska inga delrader sparas och samma fil ska inte kunna importeras två gånger.
7. Kör `supabase/migrations/004_monotonic_plan_sync.sql`. Den gör planloggarnas upsert monoton så att en äldre eller fördröjd synkning inte kan skriva över en nyare check-in.
8. Verifiera som inloggad ägare att appen kan läsa och skriva, att en upprepad FIT-fil markeras som redan importerad och att planloggar kan hämtas tillbaka. Verifiera med ett annat syntetiskt testkonto att ägarens rader inte kan läsas eller ändras.

Kör inte migrationerna mot staging eller produktion utan separat behörighet, verifierad backup och en rollbackplan. Repositoryt kan bara granska SQL-definitionerna statiskt; det bevisar inte vilka policies som faktiskt är aktiva i en fjärrmiljö.

## Funktioner

- **Översikt:** veckovolym, pace-/pulstrend och aktivitetslista.
- **Passdetaljer:** km-splits, laps, HR-zoner och grafer.
- **Import:** FIT-parsning direkt i webbläsaren, atomisk och dubblettsäker lagring samt validerad manuell registrering.
- **Analys och planering:** belastning, passklassning och träningsplan.
- **Inställningar:** pulsgränser och dataexport.

## Data och session

- `activities` lagrar passens summering, filnamn och anteckningar.
- `laps`, `km_splits` och `time_series` lagrar detaljdata per pass.
- `nutrition_logs` och valfria `training_plan_logs` lagrar användarens loggar.
- Vilopuls, maxpuls och lokala planinställningar sparas i `localStorage`.
- Supabase-sessionen sparas i `sessionStorage`, så en ny webbläsarsession kräver ny inloggning.
- Dynamisk text från filer, importer och backend ska gå via DOM-`textContent` eller den testade `js/security.js`-gränsen.

## Publicering

Projektet kan tekniskt köras på GitHub Pages, men publicering ingår inte i den lokala MVP-grinden. Publicera först efter att RLS har verifierats i rätt Supabase-miljö och efter ett separat deploybeslut.
