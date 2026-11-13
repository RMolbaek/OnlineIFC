// Vispecta – about page: language (English in the HTML; Danish and German here), image zoom
// and a gentle reveal on scroll. The language is shared with the app (same storage key).
(() => {
  // Rasmus' LinkedIn profile; the links stay hidden while this is empty
  const LINKEDIN = '';

  const T = {
    da: {
      'nav.features': 'Funktioner', 'nav.privacy': 'Privatliv', 'nav.faq': 'Spørgsmål', 'nav.lang': 'Sprog',
      'cta.open': 'Åbn Vispecta', 'cta.github': 'Kildekoden på GitHub',
      'hero.eyebrow': 'IFC-viewer til infrastruktur',
      'hero.title': 'Snit, stationer og profiler – direkte fra dine IFC-modeller.',
      'hero.lead': 'Vispecta åbner IFC-modeller i browseren og laver tværsnit, længdeprofiler og tegninger – skabt til bane- og vejprojekter. Gratis, open source, og dine filer forlader aldrig din computer.',
      'fact.free': 'Gratis', 'fact.oss': 'Open source · AGPL-3.0', 'fact.local': 'Kører lokalt',
      'story.quote': '“Som ingeniør i jernbaneprojekter sprang jeg konstant mellem programmer for at lave et snit, tjekke en model eller finde rundt langs linjeføringen. Vispecta samler de værktøjer, jeg manglede, ét sted – i browseren, uden at installere noget.”',
      'story.role': 'Jernbaneingeniør og ophavsmand til Vispecta',
      'feat.title': 'Lavet til den måde, infrastruktur bliver læst på',
      'feat.lead': 'Linjeføringer, stationer og tværsnit er bane- og vejfagets sprog. Vispecta taler det.',
      'f1.tag': 'Linjeføring & stationering', 'f1.title': 'Snit ved enhver station',
      'f1.text': 'Vispecta læser IFC 4.3-linjeføringer med stationering. Skriv en station, og få et tværsnit præcis dér – med klassiske A–A-snitpile i modellen – eller kør langs sporet. Ingen linjeføring i filen? Tegn en linje, og brug den på samme måde.',
      'f1.l1': 'IfcAlignment med stationsmærker og kilometerpæle', 'f1.l2': 'Skraverede snitflader i modellens farver', 'f1.l3': 'Bladr mellem stationer med piletasterne',
      'f2.tag': 'Snitvindue', 'f2.title': 'Se plan og snit side om side',
      'f2.text': 'Snitvinduet viser det levende 2D-snit, mens du bevæger dig gennem modellen. Sæt det på en skærm nummer to, aflæs afstande og koter i knækpunkterne, og lad nøgleplanen vise, hvor du er.',
      'f2.l1': 'Afstand / kote i hvert knækpunkt', 'f2.l2': 'Nøgleplan med snitlinje og kigretning', 'f2.l3': 'Kan åbnes i sit eget vindue',
      'f3.tag': 'Tegninger', 'f3.title': 'Fra model til tegning med ét klik',
      'f3.text': 'Eksportér snit som PDF, SVG eller DXF – i målestok, med titelblok, visningen bag snittet og et bånd med afstande, koter og hældninger. Lav en hel serie tværsnit i én PDF.',
      'f3.l1': 'PDF, SVG og DXF med lag', 'f3.l2': 'Annoteringsbånd: afstand, kote, hældning', 'f3.l3': 'Én side pr. station i en serie',
      'f4.tag': 'Længdeprofiler', 'f4.title': 'Fold modellen ud langs linjen',
      'f4.text': 'Et længdeprofil langs en linjeføring eller en linje, du selv tegner fra A til B: alt, hvad linjen passerer, foldet ud med stationer og koter – klar til eksport.',
      'f5.tag': 'Mange modeller, én visning', 'f5.title': 'Saml fagene',
      'f5.text': 'Indlæs spor, vej, bro og bygning på én gang – placeret efter deres koordinater. Saml dem i grupper, giv dem navne, du kan genkende, tænd og sluk hele grupper, flet dem til én fil, eller sammenlign to versioner.',
      'f6.tag': 'Modelkontrol', 'f6.title': 'Tjek informationerne, ikke kun geometrien',
      'f6.text': 'Kør IDS-tjek (buildingSMART Information Delivery Specification) med IfcOpenShells ifctester, se hvad der består og fejler i modellen, og skriv sager som BCF. Eksempler på IDS-filer følger med.',
      'g1.t': 'Mål', 'g1.d': 'Afstande, koter og koordinater med snap – også i kortkoordinater.',
      'g2.t': 'Mængder', 'g2.d': 'Antal, volumen, areal og længde pr. klasse, etage eller egenskab – til CSV.',
      'g3.t': 'Sammenlign & flet', 'g3.d': 'Se hvad der er tilføjet, fjernet eller ændret mellem to versioner. Flet modeller til én IFC.',
      'g4.t': 'Python indbygget', 'g4.d': 'Skriv scripts mod modellen med IfcOpenShell, direkte i browseren.',
      'g5.t': 'Ret metadata', 'g5.d': 'Ret navne og egenskaber, og download den rettede IFC.',
      'g6.t': 'Farveblind-venlig', 'g6.d': 'En farvestil baseret på Okabe–Ito-paletten, plus afdæmpet, lys og kraftig.',
      'g7.t': 'Virker offline', 'g7.d': 'Installér den som app. Efter første besøg starter den uden forbindelse.',
      'g8.t': 'Fire sprog', 'g8.d': 'Engelsk, dansk, tysk og hindi.',
      'priv.eyebrow': 'Privatliv indbygget', 'priv.title': 'Dine modeller bliver på din computer.',
      'priv.text': 'Vispecta har ingen server, der ser dine filer. Alt – at læse IFC, lave snit, tjekke IDS og køre Python – sker i din browser med WebAssembly.',
      'priv.l1t': 'Ingen upload', 'priv.l1': 'IFC-, BCF- og IDS-filer behandles lokalt.',
      'priv.l2t': 'Ingen sporing', 'priv.l2': 'Ingen cookies, ingen statistik, ingen konti.',
      'priv.l3t': 'Gemt i din browser', 'priv.l3': 'Projekter og indstillinger bliver kun i denne browser.',
      'priv.l4t': 'Selvforsynende', 'priv.l4': 'Appen, skrifttyperne og Python-delen hentes alle fra vispecta.com selv.',
      'faq.title': 'Spørgsmål',
      'q1': 'Er det gratis?', 'a1': 'Ja. Vispecta er gratis at bruge – også på arbejdet og i kommercielle projekter.',
      'q2': 'Hvad betyder open source under AGPL-3.0 for mig?', 'a2': 'Du kan bruge Vispecta frit og se al koden. Hvis nogen ændrer den og deler den – eller kører en ændret version som tjeneste – skal de offentliggøre ændringerne under samme licens. Så ingen kan tage den, lukke den og sælge den som deres egen.',
      'q3': 'Bliver mine filer uploadet nogen steder?', 'a3': 'Nej. Filerne læses og behandles i din browser. Intet om dine modeller sendes til vispecta.com eller andre.',
      'q4': 'Hvilke IFC-versioner virker?', 'a4': 'IFC 2x3, IFC 4 og IFC 4.3 (inklusive IfcAlignment). Store modeller på flere hundrede MB virker i en browser på en computer med nok hukommelse.',
      'q5': 'Hvad betyder “beta”?', 'a5': 'Vispecta er nyt og i vækst. Ikke alle funktioner er testet på alle slags modeller, så der kan være fejl – meld dem gerne.',
      'q6': 'Hvilken browser skal jeg bruge?', 'a6': 'En opdateret Chrome, Edge, Firefox eller Safari på en computer. Telefoner og tablets kan vise modeller, men værktøjerne er lavet til en større skærm.',
      'con.title': 'Vær med til at forme Vispecta', 'con.text': 'Idéer fra rigtige projekter giver de bedste funktioner. Fortæl hvad du mangler, meld en fejl, eller bidrag med kode.',
      'con.idea': 'Del en idé eller en fejl', 'con.code': 'Bidrag med kode',
      'foot.credit': 'Skærmbillederne viser IFC 4.3-eksempelscenen fra buildingSMART International (CC BY 4.0).',
      _title: 'Om Vispecta – en gratis IFC-viewer til bane- og vejprojekter',
    },
    de: {
      'nav.features': 'Funktionen', 'nav.privacy': 'Datenschutz', 'nav.faq': 'Fragen', 'nav.lang': 'Sprache',
      'cta.open': 'Vispecta öffnen', 'cta.github': 'Quellcode auf GitHub',
      'hero.eyebrow': 'IFC-Viewer für Infrastruktur',
      'hero.title': 'Schnitte, Stationen und Profile – direkt aus Ihren IFC-Modellen.',
      'hero.lead': 'Vispecta öffnet IFC-Modelle im Browser und macht daraus Querschnitte, Längsprofile und Zeichnungen – gemacht für Bahn- und Straßenprojekte. Kostenlos, Open Source, und Ihre Dateien verlassen nie Ihren Computer.',
      'fact.free': 'Kostenlos', 'fact.oss': 'Open Source · AGPL-3.0', 'fact.local': 'Läuft lokal',
      'story.quote': '„Als Ingenieur in Bahnprojekten bin ich ständig zwischen Programmen gewechselt, um einen Schnitt zu machen, ein Modell zu prüfen oder mich entlang der Achse zurechtzufinden. Vispecta bringt die Werkzeuge, die mir gefehlt haben, an einen Ort – im Browser, ohne Installation.“',
      'story.role': 'Bahningenieur und Autor von Vispecta',
      'feat.title': 'Gemacht dafür, wie Infrastruktur gelesen wird',
      'feat.lead': 'Achsen, Stationen und Querschnitte sind die Sprache von Bahn und Straße. Vispecta spricht sie.',
      'f1.tag': 'Achsen & Stationierung', 'f1.title': 'Schnitt an jeder Station',
      'f1.text': 'Vispecta liest IFC-4.3-Achsen mit ihrer Stationierung. Geben Sie eine Station ein und erhalten Sie genau dort einen Querschnitt – mit klassischen Schnittpfeilen A–A im Modell – oder fahren Sie das Gleis entlang. Keine Achse in der Datei? Zeichnen Sie eine Linie und nutzen Sie sie genauso.',
      'f1.l1': 'IfcAlignment mit Stationsbeschriftung und Kilometersteinen', 'f1.l2': 'Schraffierte Schnittflächen in den Modellfarben', 'f1.l3': 'Mit den Pfeiltasten durch die Stationen',
      'f2.tag': 'Schnittfenster', 'f2.title': 'Lageplan und Schnitt nebeneinander',
      'f2.text': 'Das Schnittfenster zeigt den Live-2D-Schnitt, während Sie sich durch das Modell bewegen. Legen Sie es auf einen zweiten Bildschirm, lesen Sie Abstände und Höhen an den Knickpunkten ab, und der Übersichtsplan zeigt, wo Sie sind.',
      'f2.l1': 'Abstand / Höhe an jedem Knickpunkt', 'f2.l2': 'Übersichtsplan mit Schnittlinie und Blickrichtung', 'f2.l3': 'Auf Wunsch in einem eigenen Fenster',
      'f3.tag': 'Zeichnungen', 'f3.title': 'Vom Modell zur Zeichnung mit einem Klick',
      'f3.text': 'Exportieren Sie Schnitte als PDF, SVG oder DXF – maßstäblich, mit Schriftfeld, der Ansicht hinter dem Schnitt und einem Band mit Abständen, Höhen und Neigungen. Eine ganze Querschnittsserie in einer PDF.',
      'f3.l1': 'PDF, SVG und DXF mit Layern', 'f3.l2': 'Beschriftungsband: Abstand, Höhe, Neigung', 'f3.l3': 'Eine Seite pro Station in einer Serie',
      'f4.tag': 'Längsprofile', 'f4.title': 'Das Modell entlang der Linie abwickeln',
      'f4.text': 'Ein Längsprofil entlang einer Achse oder einer selbst gezeichneten Linie von A nach B: alles, was die Linie durchläuft, abgewickelt mit Stationen und Höhen – bereit zum Export.',
      'f5.tag': 'Viele Modelle, eine Ansicht', 'f5.title': 'Die Fachbereiche zusammenbringen',
      'f5.text': 'Laden Sie Gleis, Straße, Brücke und Gebäude gemeinsam – platziert nach ihren Koordinaten. Gruppieren Sie sie, geben Sie ihnen vertraute Namen, schalten Sie ganze Gruppen ein und aus, führen Sie sie zu einer Datei zusammen oder vergleichen Sie zwei Versionen.',
      'f6.tag': 'Modellprüfung', 'f6.title': 'Die Informationen prüfen, nicht nur die Geometrie',
      'f6.text': 'Führen Sie IDS-Prüfungen (buildingSMART Information Delivery Specification) mit dem ifctester von IfcOpenShell aus, sehen Sie im Modell, was besteht und was nicht, und schreiben Sie Themen als BCF. Beispiel-IDS-Dateien sind enthalten.',
      'g1.t': 'Messen', 'g1.d': 'Abstände, Höhen und Koordinaten mit Fang – auch in Landeskoordinaten.',
      'g2.t': 'Mengen', 'g2.d': 'Anzahl, Volumen, Fläche und Länge pro Klasse, Geschoss oder Eigenschaft – als CSV.',
      'g3.t': 'Vergleichen & zusammenführen', 'g3.d': 'Sehen, was zwischen zwei Versionen hinzugekommen, entfernt oder geändert ist. Modelle zu einer IFC zusammenführen.',
      'g4.t': 'Python inklusive', 'g4.d': 'Das Modell mit IfcOpenShell skripten, direkt im Browser.',
      'g5.t': 'Metadaten bearbeiten', 'g5.d': 'Namen und Eigenschaften korrigieren und die korrigierte IFC herunterladen.',
      'g6.t': 'Farbenblind-freundlich', 'g6.d': 'Ein Farbstil auf Basis der Okabe–Ito-Palette, dazu gedämpft, hell und kräftig.',
      'g7.t': 'Funktioniert offline', 'g7.d': 'Als App installieren. Nach dem ersten Besuch startet sie ohne Verbindung.',
      'g8.t': 'Vier Sprachen', 'g8.d': 'Englisch, Dänisch, Deutsch und Hindi.',
      'priv.eyebrow': 'Datenschutz eingebaut', 'priv.title': 'Ihre Modelle bleiben auf Ihrem Computer.',
      'priv.text': 'Vispecta hat keinen Server, der Ihre Dateien sieht. Alles – IFC lesen, Schnitte erzeugen, IDS prüfen, Python ausführen – geschieht in Ihrem Browser mit WebAssembly.',
      'priv.l1t': 'Kein Upload', 'priv.l1': 'IFC-, BCF- und IDS-Dateien werden lokal verarbeitet.',
      'priv.l2t': 'Kein Tracking', 'priv.l2': 'Keine Cookies, keine Statistik, keine Konten.',
      'priv.l3t': 'Im Browser gespeichert', 'priv.l3': 'Projekte und Einstellungen bleiben nur in diesem Browser.',
      'priv.l4t': 'Eigenständig', 'priv.l4': 'App, Schriften und Python-Laufzeit kommen alle von vispecta.com selbst.',
      'faq.title': 'Fragen',
      'q1': 'Ist es kostenlos?', 'a1': 'Ja. Vispecta ist kostenlos – auch bei der Arbeit und in kommerziellen Projekten.',
      'q2': 'Was bedeutet Open Source unter AGPL-3.0 für mich?', 'a2': 'Sie können Vispecta frei nutzen und den gesamten Code einsehen. Wer es ändert und weitergibt – oder eine geänderte Version als Dienst betreibt – muss die Änderungen unter derselben Lizenz veröffentlichen. So kann niemand es nehmen, verschließen und als eigenes Produkt verkaufen.',
      'q3': 'Werden meine Dateien irgendwo hochgeladen?', 'a3': 'Nein. Die Dateien werden in Ihrem Browser gelesen und verarbeitet. Nichts über Ihre Modelle wird an vispecta.com oder andere gesendet.',
      'q4': 'Welche IFC-Versionen funktionieren?', 'a4': 'IFC 2x3, IFC 4 und IFC 4.3 (einschließlich IfcAlignment). Große Modelle von mehreren hundert MB funktionieren in einem Desktop-Browser mit genug Arbeitsspeicher.',
      'q5': 'Was bedeutet „Beta“?', 'a5': 'Vispecta ist neu und wächst. Nicht jede Funktion wurde mit jeder Art von Modell getestet, rechnen Sie also mit einzelnen Fehlern – und melden Sie sie bitte.',
      'q6': 'Welchen Browser brauche ich?', 'a6': 'Ein aktuelles Chrome, Edge, Firefox oder Safari auf einem Computer. Telefone und Tablets können Modelle anzeigen, die Werkzeuge sind aber für einen größeren Bildschirm gemacht.',
      'con.title': 'Gestalten Sie Vispecta mit', 'con.text': 'Ideen aus echten Projekten ergeben die besten Funktionen. Sagen Sie uns, was Sie brauchen, melden Sie einen Fehler oder tragen Sie Code bei.',
      'con.idea': 'Idee oder Fehler melden', 'con.code': 'Code beitragen',
      'foot.credit': 'Die Bildschirmfotos zeigen die IFC-4.3-Beispielszene von buildingSMART International (CC BY 4.0).',
      _title: 'Über Vispecta – ein kostenloser IFC-Viewer für Bahn- und Straßenprojekte',
    },
  };

  const KEY = 'onlineifc.lang'; // shared with the app
  const els = [...document.querySelectorAll('[data-t]')];
  const en = new Map(els.map((e) => [e, e.textContent]));
  const enTitle = document.title;

  function pick() {
    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch { /* ignore */ }
    if (saved === 'en' || T[saved]) return saved;
    for (const l of navigator.languages || [navigator.language || 'en']) {
      const code = String(l).slice(0, 2).toLowerCase();
      if (code === 'en' || T[code]) return code;
      if (code === 'nb' || code === 'nn' || code === 'no' || code === 'sv') return 'da'; // Scandinavian readers
    }
    return 'en';
  }

  function apply(lang) {
    const d = T[lang] || {};
    for (const e of els) e.textContent = d[e.dataset.t] ?? en.get(e);
    document.title = d._title || enTitle;
    document.documentElement.lang = lang;
    document.getElementById('lang').value = lang;
  }

  const sel = document.getElementById('lang');
  sel.addEventListener('change', () => {
    try { localStorage.setItem(KEY, sel.value); } catch { /* ignore */ }
    apply(sel.value);
  });
  apply(pick());

  if (LINKEDIN) for (const a of document.querySelectorAll('#linkedin, #linkedin-foot')) { a.href = LINKEDIN; a.hidden = false; a.rel = 'me noopener'; }

  // click a screenshot to see it large
  const zoom = document.getElementById('zoom');
  const zimg = zoom.querySelector('img');
  for (const f of document.querySelectorAll('.frame img')) {
    f.addEventListener('click', () => { zimg.src = f.currentSrc || f.src; zimg.alt = f.alt; zoom.showModal(); });
  }
  zoom.addEventListener('click', () => zoom.close());

  // reveal sections when they scroll into view
  if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
    }, { rootMargin: '0px 0px -10% 0px' });
    for (const el of document.querySelectorAll('.feature, .card, blockquote, .priv-list li, .contribute-in')) { el.classList.add('reveal'); io.observe(el); }
  }
})();
