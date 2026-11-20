# Notizen – einfache Android-App

Eine kleine, eigenständige Android-App zum Erfassen von Notizen.

- 📝 Notizen mit Titel und Text anlegen und bearbeiten – **gespeichert wird automatisch** beim Verlassen
- 🔎 Suche über Titel und Text
- 🗑️ Löschen (in der Notiz über das Papierkorb-Symbol oder in der Liste lange antippen)
- 📤 Teilen (z. B. per WhatsApp, Mail)
- Liste sortiert nach „zuletzt geändert“; leere neue Notizen werden verworfen
- Alle Daten bleiben auf dem Handy (`notes.json` im privaten App-Speicher), keine Berechtigungen nötig

Technik: Kotlin, reines Android-Framework (keine Zusatzbibliotheken), minSdk 24 (Android 7.0), targetSdk 35.

## APK bekommen

**Über GitHub (ohne eigenes Android Studio):** Bei jedem Push baut
GitHub Actions die App (Workflow „Android Notizen-App bauen“, auch manuell startbar).
Im Lauf unter **Artifacts → notizen-apk** die ZIP-Datei herunterladen, `app-debug.apk` aufs Handy
kopieren und öffnen (einmalig „Installation aus unbekannten Quellen“ erlauben).

**Lokal:** Projektordner in Android Studio öffnen und starten, oder

```bash
./gradlew assembleDebug
```

Die APK liegt dann unter `app/build/outputs/apk/debug/app-debug.apk`.
