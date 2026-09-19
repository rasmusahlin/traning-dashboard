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

För en befintlig installation behövs tilläggsmigrationerna **003, 004, 005 i den ordningen**, efter tidigare 001 och 002. Kör inga migrationer mot en okontrollerad databas. Frontend och databasändringarna är förberedda lokalt; publicering och ändring av den riktiga databasen kräver separat godkännande.

För en ny installation: kör `schema.sql`, därefter migrationerna i `supabase/migrations` i nummerordning. Kontrollera avsedd ägare i 001 före körning. Skapa/invitera kontot i Supabase Auth och konfigurera rätt URL och publik anon-nyckel i `js/db.js`. Anon-nyckeln är avsedd för frontend; en service-role-nyckel får aldrig användas där.

- `001_owner_rls_auth.sql`: inloggning och ägarskydd för aktiviteter och detaljer.
- `002_training_plan_logs.sql`: planloggar och deras ägarskydd.
- `003_activity_import.sql`: gemensam atomisk import, importidentitet, dubblettskydd, timer-/total tid och sparad zonfördelning. Gamla pass med entydig match kan kompletteras; tvetydiga matchningar kräver granskning.
- `004_plan_activity_links.sql`: koppling till faktisk aktivitet, en aktivitet per planlogg, kontroll av gemensam ägare och servergenererad monoton sparversion för konfliktkontroll.
- `005_training_profiles.sql`: gemensam profil och versionskontroll vid sparning.

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

## Sparat arbetsläge – lokalt färdigt 2026-09-19

Återupptaget på användarens begäran. Den lokala implementationen och slutkontrollerna är klara. Inget har publicerats eller körts mot produktionsdatabasen.

- **Beställt resultat:** tydlig träningsutveckling och nuläge, målbaserade planförslag, enkel Garmin-import och uttryckligen bibehållen enkel extrapolerad prognos. Befintlig statisk webbplats och Supabase behålls.
- **Git:** branch `feature/sub40-training-plan`, HEAD `b0540ab85cfa3bf4ef185e41fa3785e1c94e5f08`. Ändringar och nya filer finns i arbetskatalogen utan commit/push. Bevara dem. Inget nytt PR skapades.
- **Levererat lokalt:** översikt, jämförbara pass och prognos, mål/profil, aktuell veckoplan och koppling till faktiska pass, säkrare FIT/ZIP-import med originalarkiv, timer/total tid och sparade pulszoner. Migrationerna 003–005 är förberedda lokalt.
- **Slutfix:** planloggar får en strikt stigande servertidsstämpel i migration 004. Klienten jämför hela servervärdet utan att tappa mikrosekunder. Samtidiga ändringar ger konflikt i stället för tyst överskrivning. Planbyte väntar på pågående sparning och behåller konto/block. En andra lokal ändring under synkning bevaras som väntande och visas inte som permanent pågående synkning.
- **Verifierat:** 41/41 vanliga tester och 10/10 PostgreSQL/PGlite-kontroller passerar; inga överhoppade tester. `git diff --check` är utan anmärkning. Oberoende granskning godkände den sista konfliktfixen. Det tidigare hängande planbytestestet är rättat och har fem sekunders tidsgräns.
- **Webbläsarkontroll:** syntetisk översikt och bibehållen prognos, synlig historikväljare, skapa/uppdatera check-in, omladdning och växling mellan aktuell plan och arkiv fungerade; inga konsolfel i slutkontrollen. Tidigare under samma uppdrag verifierades även profil, aktivitetsdetaljer, klassning, ZIP-import och återimport utan dubblett. Ingen riktig träningsdata användes.
- **Workers:** import, utvecklingsanalys, plan och oberoende review är avslutade; inga kvarvarande blockerande workers. Resultaten finns lokalt i projektet och i samma uppgift.
- **Förhandsvisning:** `http://127.0.0.1:8903/index.html` visar enbart syntetiska data. Starta vid behov med `node tests/preview-server.cjs 8903`; testkontots molndata återställs när servern startar om. Testmotorn finns för närvarande i `/private/tmp/training-dashboard-test-runtime/node_modules/@electric-sql/pglite`; kontrollera sökvägen eftersom temporära filer kan försvinna.
- **Mandat och nästa steg:** lokal implementation/verifiering är godkänd och klar. Produktion, riktig databas, merge, push och publicering kräver ett separat uttryckligt godkännande. Nästa steg är ett samlat beslut om backup, migrationerna 003–005, publicering, driftkontroll och återställning av tidigare frontend vid fel enligt driftsättningsordningen ovan. Inga nya tjänster eller abonnemang behövs.
- **Tidigare verifierat publiceringsmål:** GitHub `rasmusahlin/traning-dashboard`, Pages från `main` och `/`, webbplats `https://rasmusahlin.github.io/traning-dashboard/`; anslutet Supabase-projekt `mpmtvydpiihfltldaxkt`. Verifiera mål och åtkomst igen inför godkända driftåtgärder. Integrationsproven ersätter inte kontroll av verklig Supabase Auth/PostgREST i rätt miljö.
