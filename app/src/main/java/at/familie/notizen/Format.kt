package at.familie.notizen

import android.content.Context
import android.text.format.DateUtils
import java.text.DateFormat
import java.util.Date

/** Datum wie „Heute, 14:05“ oder „12.11.2026, 09:30“. */
fun formatDate(context: Context, millis: Long): String {
    val time = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(millis))
    return when {
        DateUtils.isToday(millis) -> "Heute, $time"
        DateUtils.isToday(millis + DateUtils.DAY_IN_MILLIS) -> "Gestern, $time"
        else -> DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(millis))
    }
}

fun displayTitle(context: Context, note: Note): String {
    val title = note.title.trim()
    if (title.isNotEmpty()) return title
    val firstLine = note.content.trim().lineSequence().firstOrNull()?.trim().orEmpty()
    return firstLine.ifEmpty { context.getString(R.string.untitled) }
}
