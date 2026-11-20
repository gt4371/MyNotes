# Notizen

Einfache Notizen-App in zwei Varianten:

| | Web-App (`web/`) | Android-App (`app/`) |
|---|---|---|
| Installation | Im Browser öffnen, „Zum Startbildschirm hinzufügen“ | APK installieren |
| Offline | ✅ nach dem ersten Öffnen | ✅ |
| Speicherort | Browser-Speicher (IndexedDB) auf dem Gerät | App-Speicher (`notes.json`) |
| Export/Import als Datei | ✅ | – |

Beide: Notizen mit Titel und Text, **automatisches Speichern**, Suche, Teilen, Löschen;
sortiert nach „zuletzt geändert“; leere neue Notizen werden verworfen; keine Daten verlassen das Gerät.

## Web-App

Adresse: **https://gt4371.github.io/MyNotes/**

1. Auf dem Handy in **Chrome** öffnen.
2. Menü **⋮ → „Zum Startbildschirm hinzufügen“** bzw. **„App installieren“**.
3. Fertig – ab jetzt startet „Notizen“ wie eine App, auch ohne Internet.

**Dateien:** Im Menü ⋮ der Liste gibt es
- **Sicherung exportieren** – alle Notizen als `notizen-sicherung-JJJJ-MM-TT.json` (Ordner „Downloads“),
- **Alle als Textdatei exportieren** – lesbare `.txt`-Datei,
- **Importieren** – eine Sicherung zurückladen (bereits vorhandene, neuere Notizen bleiben unverändert) oder `.txt`-Dateien als neue Notizen.

In einer Notiz speichert **⋮ → Als Textdatei speichern** diese eine Notiz als `.txt`.

⚠️ Die Notizen liegen im Browser. Wer in Chrome „Browserdaten löschen“ inkl. Website-Daten wählt, löscht sie mit –
deshalb ab und zu eine **Sicherung exportieren**. Das Menü zeigt, wann zuletzt gesichert wurde.

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
