package at.familie.notizen

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import java.io.File

/** Speichert alle Notizen als JSON-Datei im privaten App-Speicher. */
class NoteStore private constructor(context: Context) {

    private val file = AtomicFile(File(context.filesDir, "notes.json"))
    private val notes = mutableListOf<Note>()

    init {
        load()
    }

    /** Alle Notizen, zuletzt geänderte zuerst. */
    fun all(): List<Note> = notes.sortedByDescending { it.updated }

    fun get(id: Long): Note? = notes.firstOrNull { it.id == id }

    fun create(): Note {
        val now = System.currentTimeMillis()
        val id = maxOf(now, (notes.maxOfOrNull { it.id } ?: 0L) + 1)
        return Note(id, "", "", now, now)
    }

    /** Speichert eine neue oder geänderte Notiz. */
    fun save(note: Note) {
        note.updated = System.currentTimeMillis()
        val index = notes.indexOfFirst { it.id == note.id }
        if (index >= 0) notes[index] = note else notes.add(note)
        persist()
    }

    fun delete(id: Long) {
        if (notes.removeAll { it.id == id }) persist()
    }

    private fun load() {
        notes.clear()
        if (!file.baseFile.exists()) return
        try {
            val array = JSONArray(String(file.readFully(), Charsets.UTF_8))
            for (i in 0 until array.length()) {
                notes.add(Note.fromJson(array.getJSONObject(i)))
            }
        } catch (e: Exception) {
            // Beschädigte Datei: mit leerer Liste weitermachen
        }
    }

    private fun persist() {
        val array = JSONArray()
        notes.forEach { array.put(it.toJson()) }
        val out = file.startWrite()
        try {
            out.write(array.toString().toByteArray(Charsets.UTF_8))
            file.finishWrite(out)
        } catch (e: Exception) {
            file.failWrite(out)
            throw e
        }
    }

    companion object {
        @Volatile
        private var instance: NoteStore? = null

        fun get(context: Context): NoteStore =
            instance ?: synchronized(this) {
                instance ?: NoteStore(context.applicationContext).also { instance = it }
            }
    }
}
