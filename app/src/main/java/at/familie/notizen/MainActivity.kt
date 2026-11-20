package at.familie.notizen

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {

    private lateinit var store: NoteStore
    private lateinit var adapter: NoteAdapter
    private lateinit var emptyView: TextView
    private lateinit var search: EditText

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        store = NoteStore.get(this)

        emptyView = findViewById(R.id.empty)
        search = findViewById(R.id.search)
        adapter = NoteAdapter()

        val list = findViewById<ListView>(R.id.list)
        list.adapter = adapter
        list.setOnItemClickListener { _, _, position, _ ->
            openNote(adapter.getItem(position).id)
        }
        list.setOnItemLongClickListener { _, _, position, _ ->
            confirmDelete(adapter.getItem(position))
            true
        }

        findViewById<View>(R.id.add).setOnClickListener { openNote(null) }

        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) = refresh()
        })
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun openNote(id: Long?) {
        val intent = Intent(this, EditActivity::class.java)
        if (id != null) intent.putExtra(EditActivity.EXTRA_ID, id)
        startActivity(intent)
    }

    private fun confirmDelete(note: Note) {
        AlertDialog.Builder(this)
            .setTitle(displayTitle(this, note))
            .setMessage(R.string.delete_question)
            .setPositiveButton(R.string.delete) { _, _ ->
                store.delete(note.id)
                Toast.makeText(this, R.string.deleted, Toast.LENGTH_SHORT).show()
                refresh()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun refresh() {
        val query = search.text.toString().trim()
        val notes = store.all().filter {
            query.isEmpty() ||
                it.title.contains(query, ignoreCase = true) ||
                it.content.contains(query, ignoreCase = true)
        }
        adapter.setNotes(notes)
        emptyView.visibility = if (notes.isEmpty()) View.VISIBLE else View.GONE
        emptyView.setText(if (query.isEmpty()) R.string.empty else R.string.no_results)
    }

    private inner class NoteAdapter : BaseAdapter() {
        private var notes: List<Note> = emptyList()

        fun setNotes(newNotes: List<Note>) {
            notes = newNotes
            notifyDataSetChanged()
        }

        override fun getCount() = notes.size
        override fun getItem(position: Int) = notes[position]
        override fun getItemId(position: Int) = notes[position].id

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val view = convertView
                ?: layoutInflater.inflate(R.layout.item_note, parent, false)
            val note = notes[position]
            view.findViewById<TextView>(R.id.title).text = displayTitle(this@MainActivity, note)

            val preview = view.findViewById<TextView>(R.id.preview)
            val body = if (note.title.isBlank()) {
                note.content.trim().lineSequence().drop(1).joinToString(" ").trim()
            } else {
                note.content.trim().replace('\n', ' ')
            }
            preview.text = body
            preview.visibility = if (body.isEmpty()) View.GONE else View.VISIBLE

            view.findViewById<TextView>(R.id.date).text = formatDate(this@MainActivity, note.updated)
            return view
        }
    }
}
