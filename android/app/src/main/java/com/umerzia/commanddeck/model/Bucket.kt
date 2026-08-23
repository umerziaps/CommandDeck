package com.umerzia.commanddeck.model

/**
 * The three lanes of the board.
 *
 * Persisted as its [wire] string, which must match the values the iOS and
 * web clients write — see FIREBASE-SETUP.md.
 */
enum class Bucket(val wire: String, val title: String, val emptyMessage: String) {
    NOW("now", "Now", "Nothing active. Pull something up from Later when you start it."),
    WAITING("waiting", "Waiting", "Not waiting on anyone."),
    LATER("later", "Later", "Captured items land here. Your inbox is clear.");

    companion object {
        /** Unknown or missing values fall back to Later rather than throwing. */
        fun fromWire(value: String?): Bucket =
            entries.firstOrNull { it.wire == value } ?: LATER
    }
}
