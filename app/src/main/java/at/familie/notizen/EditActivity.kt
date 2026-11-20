package at.familie.notizen

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast

/** Notiz anlegen oder bearbeiten. Gespeichert wird automatisch beim Verlassen. */
class EditActivity : Activity() {

    private lateinit var store: NoteStore
    private lateinit var note: Note
    private lateinit var titleView: EditText
    private lateinit var contentView: EditText
    private lateinit var dateView: TextView
    private var deleted = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_edit)
        actionBar?.setDisplayHomeAsUpEnabled(true)
        store = NoteStore.get(this)

        // Nach einer Drehung o. Ä. dieselbe (evtl. schon gespeicherte) Notiz weiterverwenden
        val id = savedInstanceState?.getLong(EXTRA_ID, -1L)?.takeIf { it >= 0 }
            ?: intent.getLongExtra(EXTRA_ID, -1L).takeIf { it >= 0 }
        note = id?.let { store.get(it)?.copy() } ?: store.create()

        titleView = findViewById(R.id.title)
        contentView = findViewById(R.id.content)
        dateView = findViewById(R.id.date)

        val isNew = store.get(note.id) == null
        setTitle(if (isNew) R.string.new_note else R.string.edit_title)
        if (savedInstanceState == null) {
            titleView.setText(note.title)
            contentView.setText(note.content)
            if (isNew) contentView.requestFocus()
        }
        updateDate()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putLong(EXTRA_ID, note.id)
    }

    override fun onPause() {
        super.onPause()
        saveIfChanged()
    }

    private fun saveIfChanged() {
        if (deleted) return
        val title = titleView.text.toString()
        val content = contentView.text.toString()
        val existing = store.get(note.id)

        if (existing == null && title.isBlank() && content.isBlank()) return // leere neue Notiz verwerfen
        if (existing != null && existing.title == title && existing.content == content) return

        note.title = title
        note.content = content
        store.save(note.copy())
        note = store.get(note.id)!!.copy()
        updateDate()
    }

    private fun updateDate() {
        dateView.text = if (store.get(note.id) != null) {
            "Zuletzt geändert: " + formatDate(this, note.updated)
        } else {
            ""
        }
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.menu_edit, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean = when (item.itemId) {
        android.R.id.home -> {
            finish()
            true
        }
        R.id.action_share -> {
            share()
            true
        }
        R.id.action_delete -> {
            confirmDelete()
            true
        }
        else -> super.onOptionsItemSelected(item)
    }

    private fun share() {
        val title = titleView.text.toString().trim()
        val content = contentView.text.toString().trim()
        val text = listOf(title, content).filter { it.isNotEmpty() }.joinToString("\n\n")
        if (text.isEmpty()) return
        val send = Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_SUBJECT, title)
            .putExtra(Intent.EXTRA_TEXT, text)
        startActivity(Intent.createChooser(send, getString(R.string.share)))
    }

    private fun confirmDelete() {
        AlertDialog.Builder(this)
            .setMessage(R.string.delete_question)
            .setPositiveButton(R.string.delete) { _, _ ->
                deleted = true
                store.delete(note.id)
                Toast.makeText(this, R.string.deleted, Toast.LENGTH_SHORT).show()
                finish()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    companion object {
        const val EXTRA_ID = "note_id"
    }
}
