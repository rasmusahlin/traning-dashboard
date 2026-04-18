# Träningsdashboard

Personlig träningsdashboard för löpning, styrketräning och vandring. Bygger på Garmin FIT-filer, Supabase (PostgreSQL) och GitHub Pages.

## Kom igång

### 1. Kör SQL i Supabase

Gå till ditt Supabase-projekt → SQL Editor och kör `schema.sql` (finns i detta repo).

### 2. Publicera på GitHub Pages

1. Skapa ett nytt repo på GitHub (t.ex. `traning-dashboard`)
2. Ladda upp alla filer från detta repo
3. Gå till repo-inställningar → **Pages** → Source: **main branch / root**
4. Din dashboard finns på `https://[ditt-användarnamn].github.io/traning-dashboard`

### 3. Ladda upp ditt första pass

1. Öppna dashboarden
2. Gå till **Inställningar** → kör SQL-migrationen för laps/splits-tabeller
3. Gå till **Ladda upp** → exportera FIT från Garmin Connect → ladda upp

## Garmin FIT-export

1. Gå till connect.garmin.com
2. Klicka på ett pass
3. Kugghjulet (⚙) → **Exportera original** → sparar `.fit`-fil

## Funktioner

- **Översikt**: veckovolym, pace-trend, HR-trend, aktivitetslista
- **Pass-detaljer**: km-splits med pace + HR per km, lap-data, HR-zoner, pace/elevation-graf
- **Upload**: FIT-parsning direkt i webbläsaren, allt sparas i Supabase
- **Inställningar**: konfigurerbar maxpuls och HR-zoner

## Databasstruktur

- `activities` – summering per pass
- `laps` – Garmin-laps (auto eller manuella)
- `km_splits` – pace, HR, kadens per km
- `time_series` – per-sekund-data (nedsamplad till ~500 punkter)

## Anpassa

Ändra Supabase URL/nyckel i `js/db.js` om du byter projekt.
Maxpuls och HR-zoner konfigureras under Inställningar och sparas i localStorage.
