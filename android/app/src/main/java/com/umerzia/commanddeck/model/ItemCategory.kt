package com.umerzia.commanddeck.model

import java.time.Instant
import java.util.UUID

data class ItemCategory(
    val id: String = UUID.randomUUID().toString(),
    val name: String = "",
    /** Hex string, e.g. "#5EE6C5". */
    val colorHex: String = PALETTE.first(),
    val createdAt: Instant = Instant.EPOCH
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "name" to name,
        "color" to colorHex,
        "createdAt" to (DeckDate.iso(createdAt) ?: Instant.now().toString())
    )

    companion object {
        /** Same ten colours the iOS and web clients offer. */
        val PALETTE = listOf(
            "#5EE6C5", "#7C89F0", "#F0B45E", "#FF6B54", "#63C7A6",
            "#C78BF0", "#F07CA8", "#8ECF5E", "#5EB8E6", "#E6C25E"
        )

        fun fromMap(id: String, raw: Map<String, Any?>): ItemCategory = ItemCategory(
            id = id,
            name = raw["name"] as? String ?: "",
            colorHex = raw["color"] as? String ?: PALETTE.first(),
            createdAt = DeckDate.parseIso(raw["createdAt"] as? String) ?: Instant.EPOCH
        )

        /** Picks the first palette colour not already taken. */
        fun nextColor(used: List<String>): String =
            PALETTE.firstOrNull { it !in used } ?: PALETTE[used.size % PALETTE.size]
    }
}
