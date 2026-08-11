# Lokal MVP-baslinje – 2026-08-11

## Omfattning

Denna baslinje avser en lokalt körbar MVP. Ingen deploy, fjärrskrivning, produktionsdata eller hemlighet användes. Automatiska tester använder endast syntetiska strängar och objekt.

## Genomfört

- Projektets varaktiga arbetsregler finns i rotens `AGENTS.md`.
- Dynamisk text från anteckningar, FIT-filnamn, fel och backenddata går via DOM-`textContent` eller den testade `js/security.js`-gränsen i de verifierade riskflödena.
- Aktivitetslistan och raderingsdialogen byggs med DOM-noder utan dynamiska inline-handlers.
- URL- och backend-ID:n måste vara UUID innan de används i PostgREST-filter.
- Planloggsimporten tillåter endast kända plandagar, fasta statusvärden, begränsade tal och rimlig anteckningslängd.
- FIT-importen begränsar filtyp, filstorlek, filnamnslängd och batchstorlek.
- Auth-sessionen normaliseras till nödvändiga fält och sparas i `sessionStorage`; äldre lokal lagring tas bort vid migrering.
- Alla sidor har en CSP som begränsar anslutningar till det konfigurerade Supabase-projektet och blockerar objektinbäddning och främmande bas-URL:er.
- `schema.sql` är fail-closed med RLS och återkallad anon-åtkomst. Migrationerna ger tabellspecifika ägarpolicies och innehåller ingen incheckad ägaradress.
- README beskriver lokal körning och den obligatoriska, säkra databasordningen.

## Verifierad grind

- `node --test`: 9 av 9 tester passerar, inklusive negativa XSS-, query-, planimport-, CSP- och RLS-bootstrapfall.
- `node --check js/security.js && node --check js/db.js && node --check js/fit-parser.js && node --check js/plan.js`: passerar.
- Alla inline-skript i HTML kompileras i testharnessen.
- `git diff --check`: passerar.
- Lokal browser, desktop 1280 px: inloggningsgrind och planvy visas utan konsolfel eller horisontell overflow.
- Lokal browser, mobil 390 px: inloggningsgrind och planvy visas utan konsolfel eller horisontell overflow.
- Planvyn laddar lokal JSON och byte till vecka 1 visar sju plandagar.
- En oberoende skrivskyddad säkerhetsgranskning fann inga blockerande slutresultat. Dess enda P2-fynd om migration 002:s constraint-kontroll åtgärdades och testades.

## Kvarvarande risker och prioriterad backlog

1. **Verifiera faktisk Supabase-miljö före publicering.** Repositoryt bevisar SQL-definitionerna men inte aktiva fjärrpolicies. Kör migrationerna endast med separat behörighet, backup och negativa tester med två isolerade testkonton.
2. **Ta bort `unsafe-inline` från CSP.** Flytta kvarvarande inline-skript och statiska inline-handlers till sidkontrollers. Ersätt inline-stilar stegvis. Detta gör CSP till en starkare sista XSS-barriär.
3. **Samla FIT-parsningen.** `upload.html` och `js/fit-parser.js` innehåller överlappande implementationer. Gör en enda parsermodul, lägg syntetiska FIT-datafall runt dess rena transformationer och bevara nuvarande enhetskonverteringar.
4. **Fortsätt dela sidkontrollers vid konkret behov.** Börja med `activity.html` och `upload.html`: flytta rena view-model- och valideringsfunktioner till små moduler. Undvik en total omskrivning.
5. **Lägg till isolerat backend-kontraktstest.** När en uttryckligen godkänd lokal/staging-Supabase finns, verifiera inloggning, refresh, CRUD, RLS-avslag och tom-/fel-/loadinglägen med syntetisk data.
6. **Minska CDN-beroendet.** Överväg lokalt pinnad Chart.js eller verifierad SRI för bättre offline-reproducerbarhet och snävare script-policy.

Ingen punkt ovan blockerar den verifierade lokala MVP-baslinjen. Punkt 1 blockerar däremot all framtida publicering mot en verklig databas.
