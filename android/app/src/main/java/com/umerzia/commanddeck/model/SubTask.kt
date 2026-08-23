package com.umerzia.commanddeck.model

import java.util.UUID

/**
 * A checklist line, stored inline on its parent item document.
 */
data class SubTask(
    val id: String = UUID.randomUUID().toString(),
    val text: String = "",
    val done: Boolean = false
) {
    fun toMap(): Map<String, Any> = mapOf(
        "id" to id,
        "text" to text,
        "done" to done
    )

    companion object {
        fun fromMap(raw: Map<*, *>): SubTask = SubTask(
            id = raw["id"] as? String ?: UUID.randomUUID().toString(),
            text = raw["text"] as? String ?: "",
            done = raw["done"] as? Boolean ?: false
        )
    }
}
