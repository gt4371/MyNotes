# MyNotes

Zwei Apps:

| | Web-App „Berichte“ (`web/`) | Android-App „Notizen“ (`app/`) |
|---|---|---|
| Installation | Im Browser öffnen, „Zum Startbildschirm hinzufügen“ | APK installieren |
| Offline | ✅ nach dem ersten Öffnen | ✅ |
| Speicherort | Browser-Speicher (IndexedDB) auf dem Gerät | App-Speicher (`notes.json`) |
| Inhalt | Berichte mit Unterpunkten, Fotos, Sprachnotizen | einfache Textnotizen |
| Export eines Berichts (HTML, Teilen, PDF) | ✅ | – |
| Export/Import als Datei | ✅ | – |

Beide: **automatisches Speichern**, Suche, Teilen, Löschen; keine Daten verlassen das Gerät.

## Web-App „Berichte“

Adresse: **https://gt4371.github.io/MyNotes/**

1. Auf dem Handy in **Chrome** öffnen.
2. Menü **⋮ → „App installieren“** bzw. **„Zum Startbildschirm hinzufügen“**.
3. Fertig – ab jetzt startet „Berichte“ wie eine App, auch ohne Internet.

**Aufbau eines Berichts**
- **Titel**, **Datum** (vorbelegt mit heute), **Ort** und **Notizen** zum ganzen Bericht;
  der Titelbereich lässt sich mit ▾/▸ einklappen (dann nur Titel + Kurzinfo mit Datum, Ort, Notizanfang)
- beliebig viele **Unterpunkte**, jeweils mit Überschrift, **Text**, Fotos und **🎤 Sprachnotizen**
- **📷 Foto** öffnet direkt die Kamera, **🖼 Galerie** wählt vorhandene Bilder (mehrere auf einmal); über ⋮ am Unterpunkt nach oben/unten verschieben oder löschen
- Unterpunkte mit ▾/▸ **ein- und ausklappen** (eingeklappt: Kurzinfo mit 📷/🎤 und Textanfang, antippen öffnet);
  Tippen auf die Überschrift **„Unterpunkte“** klappt alle ein (nochmal: alle aus);
  der Zustand bleibt auf dem Gerät gespeichert
- gespeichert wird automatisch; Fotos werden auf max. 1920 Pixel verkleinert
- Foto antippen = Vollbild mit Teilen, Speichern, Löschen; Aufnahme mit „Fertig“ beenden oder „Verwerfen“ (max. 15 Min.)

**Bericht exportieren** (Menü ⋮ im Bericht bzw. ⇪ oben):
- **Als Datei speichern (HTML)** – der ganze Bericht in *einer* Datei (`Bericht JJJJ-MM-TT Titel.html`):
  Fotos eingebettet, Sprachnotizen abspielbar; öffnet sich in jedem Browser
- **Teilen** – dieselbe Datei direkt per WhatsApp, Mail usw.
- **Drucken / als PDF speichern** – Druckansicht (Sprachnotizen nur als Hinweis mit Länge)

**Sicherung** (Menü ⋮ in der Liste): alle Berichte inkl. Fotos und Sprachnotizen als
`berichte-sicherung-JJJJ-MM-TT.json`; **Sicherung importieren** spielt sie wieder ein
(auch ältere Notizen-Sicherungen und `.txt`-Dateien). Frühere Notizen wurden automatisch zu Berichten
mit einem Unterpunkt.

⚠️ Die Daten liegen im Browser. Wer in Chrome „Browserdaten löschen“ inkl. Website-Daten wählt, löscht sie mit –
deshalb regelmäßig eine **Sicherung exportieren**. Das Menü zeigt, wann zuletzt gesichert wurde, und die App-Version.

Veröffentlicht wird automatisch per GitHub Actions („Web-App veröffentlichen“) bei jeder Änderung in `web/`.
Nach Änderungen an den App-Dateien in `web/sw.js` die `VERSION` erhöhen.

Lokal testen:

```bash
cd web && python3 -m http.server 8000
```

## Android-App

Bei jedem Push baut GitHub Actions die App (Workflow „Android Notizen-App bauen“, auch manuell startbar).
Im Lauf unter **Artifacts → notizen-apk** die ZIP-Datei herunterladen, `app-debug.apk` aufs Handy
kopieren und öffnen (einmalig „Installation aus unbekannten Quellen“ erlauben).

Lokal: Projektordner in Android Studio öffnen, oder `./gradlew assembleDebug`
(APK unter `app/build/outputs/apk/debug/app-debug.apk`).

Technik: Kotlin, reines Android-Framework (keine Zusatzbibliotheken), minSdk 24 (Android 7.0), targetSdk 35.
