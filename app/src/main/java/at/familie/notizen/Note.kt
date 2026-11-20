package at.familie.notizen

import org.json.JSONObject

data class Note(
    val id: Long,
    var title: String,
    var content: String,
    val created: Long,
    var updated: Long,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("title", title)
        .put("content", content)
        .put("created", created)
        .put("updated", updated)

    companion object {
        fun fromJson(o: JSONObject) = Note(
            id = o.getLong("id"),
            title = o.optString("title"),
            content = o.optString("content"),
            created = o.optLong("created"),
            updated = o.optLong("updated"),
        )
    }
}
