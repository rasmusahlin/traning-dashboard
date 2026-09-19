# Träningsdashboard

Personlig träningsöversikt med Garmin FIT/ZIP, en statisk webbplats och Supabase. Ingen separat applikationsserver, prenumerationstjänst eller AI-API behövs för analyser och planförslag.

## Användning

1. Ange måldistans, måltid, eventuellt måldatum samt tillgängliga dagar och minuter under **Mål & inställningar**. Kontrollera vilopuls och maxpuls.
2. Exportera original från Garmin Connect och släpp en eller flera FIT- eller ZIP-filer på **Importera**. ZIP kan innehålla undermappar. Samma original kan importeras igen utan ett nytt pass.
3. Bekräfta perioden där historiken är komplett. Tomma veckor utanför den perioden är okända, inte vila. Perioden utökas inte automatiskt.
4. Märk gärna återkommande lugna pass med underlag och runda, och test/tävling med rätt typ på passets detaljsida. Styrkepass kan få ett frivilligt arbetsset med övning, vikt och repetitioner.
5. Se översikten och **Min plan**. Bekräfta föreslagna kopplingar till genomförda pass, välj själv vid flera träffar och komplettera bara med ansträngning/obehag och eventuell kommentar.

## Vad vyerna betyder

- **Översikt:** mål, senaste relevanta test/tävling, fyra avslutade veckor jämfört med föregående fyra, kalenderveckor inklusive luckor, jämförbara lugna pass och styrkekontinuitet.
- **Utveckling:** råa trender och spårbart urval. Jämförbara pass grupperas med hänsyn till puls, varaktighet och angivet underlag/runda. Det är en beskrivande jämförelse; exempelvis väder och dagsform kan fortfarande påverka.
- **Enkel extrapolerad prognos finns kvar:** meter per hjärtslag, linjär trend och målreferens, med olika historiska urval. Tävlingspuls 91 % av angiven maxpuls är ett synligt modellantagande. Resultatet är ett scenario, inte en sannolikhet eller garanti. Prognosen undanhålls vid för få eller gamla observationer.
- **Passmix:** automatisk klassning med manuell korrigering och återställning till Auto. Ingen belastningskvot framställs som en säker skaderiskgräns.
- **Min plan:** försiktiga förslag utifrån aktuell träning, mål och tillgänglighet. Historiska planblock finns kvar i historikväljaren. Dagsform visas som okänd när underlag saknas.

Tid med aktiv timer används före hastighetsberäknad tid och sist förfluten tid för jämförelser av tempo. Total tid visas separat. Ett testresultat mot måltid använder total tid. Pulszoner räknas tidsvägt från originalets mätningar före nedsampling; långa mätluckor och pauser ska inte fyllas med antagen puls. Inställningarna som användes vid import sparas tillsammans med zonfördelningen. Äldre pass utan detta underlag visas inte som exakt zonstatistik.

## Lagring och återställning

- Aktiviteter, detaljer, mål, passmarkeringar och planloggar ligger på det inloggade kontot i Supabase med ägarskydd (RLS).
- Profil och planloggar har kontobundna lokala kopior. Synkfel visas och ändringar behålls lokalt. Vid samtidig redigering väljer användaren hur konflikten ska lösas.
- Äldre lokala inställningar/loggar importeras med en uttrycklig knapp. De saknar ägaruppgift och kopplas därför inte automatiskt till ett konto.
- FIT-original sparas privat i **den aktuella webbläsarens IndexedDB**, inte i Git eller molnet. Exportera dem via Importera; rensad webbläsardata kan annars ta bort kopian. Det är inte en automatisk molnbackup.
- **Exportera träningsdata** omfattar aktiviteter, detaljer, planloggar och profil. Coach-exporten inkluderar mål, märkningar, planloggar och beräkningskällor. Ingen export skickas automatiskt till en extern AI-tjänst. JSON-exporten är ett arkivunderlag; generell återimport av hela databasen är inte implementerad. Planloggar kan återimporteras i Min plan.

## Databas och installation

För en befintlig installation behövs tilläggsmigrationerna **005, 006, 007 i den ordningen**, efter tidigare 001–004. Kör inga migrationer mot en okontrollerad databas. Migrationerna 005–007 är installerade i den uttryckligen godkända befintliga Supabase-miljön. Andra installationer kräver eget miljöspecifikt mandat.

För en ny installation: kör `schema.sql`, därefter migrationerna i `supabase/migrations` i nummerordning. Kontrollera avsedd ägare i 001 före körning. Skapa/invitera kontot i Supabase Auth och konfigurera rätt URL och publik anon-nyckel i `js/db.js`. Anon-nyckeln är avsedd för frontend; en service-role-nyckel får aldrig användas där.

- `001_owner_rls_auth.sql`: inloggning och ägarskydd för aktiviteter och detaljer.
- `002_training_plan_logs.sql`: planloggar och deras ägarskydd.
- `003_atomic_activity_import.sql`: tidigare atomisk import, validering och hashbaserat dubblettskydd.
- `004_monotonic_plan_sync.sql`: tidigare skydd mot föråldrade planuppdateringar.
- `005_activity_import.sql`: gemensam atomisk import, importidentitet, dubblettskydd, timer-/total tid och sparad zonfördelning. Gamla pass med entydig match kan kompletteras; tvetydiga matchningar kräver granskning.
- `006_plan_activity_links.sql`: koppling till faktisk aktivitet, en aktivitet per planlogg, kontroll av gemensam ägare och servergenererad monoton sparversion för konfliktkontroll.
- `007_training_profiles.sql`: gemensam profil och versionskontroll vid sparning.

### Driftsättningsordning vid godkänt mandat

1. Verifiera Git-remote, publiceringsgren, Pages-källa och rätt Supabase-projekt. Ta export/backup och kontrollera befintliga migrationer.
2. Prova migrationer och ny frontend i isolerad testmiljö, sedan tillämpa de saknade tilläggsmigrationerna på avsedd databas. Inga befintliga pass eller anteckningar ska raderas.
3. Publicera frontend efter lyckad databasuppdatering. Kontrollera inloggning, import/återimport, profil, planlogg, export och olika kontons åtkomst.
4. Vid fel: återställ tidigare frontend-version. Tilläggskolumner/tabeller kan ligga kvar; radera inte nya träningsdata för att återställa gränssnittet. Återställning av data från backup är en separat granskad åtgärd.

## Lokal verifiering

Kräver Node.js. Ingen installation av npm-paket behövs för vanliga tester eller förhandsvisning.

```sh
node --test tests/*.test.cjs
node tests/preview-server.cjs 8903
```

Öppna `http://127.0.0.1:8903/`. Förhandsvisningen är tydligt märkt med **syntetiska testdata**, ersätter databasadressen i det serverade testsvaret och kontaktar inte din Supabase-databas. Ändringar i testkontot försvinner när servern startas om. Servern är bara ett lokalt testverktyg och ska inte användas för publicering.

PostgreSQL-integrationen kan köras mot en separat installerad `@electric-sql/pglite`:

```sh
PGLITE_PATH=/absolute/path/to/node_modules/@electric-sql/pglite node --test tests/database.integration.cjs
```

Testet använder en disponibel databas och syntetiska konton. Det kontrollerar migrationer, ägarskydd, felaktiga data, atomisk import och konflikter. Det ersätter inte verifiering av Supabase Auth och PostgREST i avsedd driftmiljö.

## Sparat arbetsläge – publicering pågår 2026-09-19

Användaren har uttryckligen godkänt säkerhetskopia, uppdatering av ansluten Supabase-databas och publicering på befintliga GitHub Pages, inklusive efterkontroll och återställning av tidigare frontend vid fel. Mandatet gäller fortsatt; fråga inte om samma godkännande igen.

- Mål: GitHub `rasmusahlin/traning-dashboard`, Pages från `main` och `/`, `https://rasmusahlin.github.io/traning-dashboard/`; Supabase `mpmtvydpiihfltldaxkt` (health Project i organisation Rasmus).
- Före publicering verifierades remote main `a1664e26320a490fd0951aea7f330ecd71929397`. Den innehåller säkerhetsförbättringar och tidigare migrationer 003–004 som saknades i den gamla lokala basen. Dessa bevaras och förenas med nyheterna före release.
- Arbetsgren `codex/training-insights-release`; lokal checkpoint `b6ee789` bevarar de godkända funktionerna före sammanfogningen. Sammanfogningen med origin/main är klar. Frontend är färdig för publicering på godkänt mål.
- Supabase återupptogs från pausat läge. Privat gzip-backup hämtades från projektets pausbackup och integritetskontrollerades; 4 871 598 byte komprimerat, SHA-256 och metadata finns i den Git-ignorerade `.private-backups/manifest.json`. Backup får aldrig publiceras.
- Migrationerna 005, 006 och 007 kördes framgångsrikt via Supabase SQL Editor 2026-09-19. CLI-inloggning fungerar för projektlistning men db query har en versions-/profilkonflikt; ingen ny inloggning behövs.
- Efterkontroll: 260 aktiviteter, 2 125 varv, 1 875 km-splits, 143 659 mätpunkter och 8 planloggar, oförändrat från före uppdatering. Profil-RLS är aktivt; anon saknar rätt att köra nya import-/profilfunktioner och plan-RPC.
- Transaktionstest i rätt databas verifierade syntetisk import, dubblettskydd, avvisad negativ distans, profilrevision/konfliktskydd, planlänk och kontoavskiljning. Hela testtransaktionen återställdes; inga testdata behölls.
- Efter sammanfogning och exportfixar passerade 67 vanliga tester och 12 PostgreSQL-tester. Oberoende granskning accepterade auth/rendering/SQL och de två exportfixarna. Dess sista fynd om historiska föreslagna veckor är rättat med regression för export/återimport och negativa datumtester. Inga implementation-workers återstår.
- Lokal webbläsarkontroll visar översikt, enkel extrapolerad prognos, aktuell veckoplan och sparad check-in. Mobilvyn och ZIP/FIT-import till testkontot kontrollerade utan konsolfel. Förhandsvisningen använder bara syntetiska data.
- Separat befintlig behörighetsfråga utanför appens egna tabeller väntar på användarens beslut. Detaljer finns i den pågående uppgiften, inte i det offentliga underlaget. Ingen ändring av det separata flödet är gjord.
- Nästa: skapa PR och publicera på godkänt Pages-mål; verifiera publicerad version och spara slutligt läge. Hantera det separata behörighetsflödet bara efter användarens beslut.
