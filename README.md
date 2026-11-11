# OnlineIFC

En IFC-viewer der kører direkte i browseren. Filerne behandles lokalt (WebAssembly) og uploades ikke nogen steder.

## Funktioner

- **Review af modeller** – åbn én eller flere `.ifc`-filer (IFC2x3, IFC4, IFC4x3) via knappen eller træk-og-slip.
- **Federering** – flere modeller lægges i samme visning. Den første model definerer koordinatsystemet, og de næste placeres i forhold til den ud fra deres egne koordinater.
- **Snit** – vandret plansnit, lodrette snit (X/Y), snit parallelt med en klikket flade og snitkasse om de valgte elementer. Hvert snit kan flyttes med en skyder, vendes, slås fra eller fjernes. Snitflader farves røde.
- **Farver** – vælg en farve og gennemsigtighed pr. model, “Farv pr. model” giver hver model sin egen farve, og “Original” går tilbage til farverne fra IFC-filen.
- **Metadata** – klik på et element for at se attributter, placering i den rumlige struktur, egenskabssæt (Pset), mængder (Qto) med enheder, type og typeegenskaber, materialer/lagopbygning og klassifikation. Panelet kan filtreres med fritekst.
- **Struktur og klasser** – et træ over projekt › grund › bygning › etage › klasse › element og en oversigt over IFC-klasser med antal. Begge kan bruges til at vælge, skjule og vise. Strukturen kan søges i (navn, klasse, GUID, tag).
- **Synlighed** – skjul, isolér, vis alt, og vis/skjul rum (IfcSpace).
- **Eksport** – alle elementers egenskaber kan eksporteres til CSV (semikolon-separeret, åbner direkte i Excel). Skærmbilleder kan gemmes som PNG.

## Genveje

| Handling | Genvej |
| --- | --- |
| Rotér / vælg | Venstre mus / klik |
| Panorér | Højre mus eller Shift + venstre |
| Zoom | Scroll (zoomer mod markøren) |
| Centrér på punkt | Dobbeltklik |
| Tilføj til / fjern fra markering | Ctrl/Shift + klik |
| Zoom til markering | F |
| Skjul / isolér / vis alt | H / I / Shift+H |
| Ryd markering | Esc |

## Udvikling

```bash
npm install
npm run dev      # udviklingsserver på http://localhost:5173
npm run build    # statisk build i dist/
npm run preview  # se det byggede site
```

Bygget med [three.js](https://threejs.org) og [web-ifc](https://github.com/ThatOpen/engine_web-ifc). Det er et rent statisk site uden backend.

## Udrulning

`.github/workflows/deploy.yml` bygger sitet og udruller det til GitHub Pages ved hvert push til `main`.
Pages skal slås til én gang: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
Mappen `dist/` kan også lægges på en hvilken som helst anden statisk webhost (Netlify, Azure Static Web Apps, S3 osv.).
