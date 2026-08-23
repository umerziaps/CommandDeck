package com.umerzia.commanddeck.model

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/**
 * Date handling for the shared wire format.
 *
 * Due dates travel as "yyyy-MM-dd" strings and timestamps as ISO-8601,
 * exactly as the iOS and web clients write them. Using strings rather than
 * Firestore Timestamps keeps all three clients — and the JSON backup
 * format — in agreement with no timezone conversion in the middle.
 *
 * Every function that needs "now" takes it as a parameter. That is what
 * makes this class testable without freezing the system clock.
 */
object DeckDate {

    private val DAY: DateTimeFormatter = DateTimeFormatter.ISO_LOCAL_DATE

    // --- wire format -----------------------------------------------------

    /** "yyyy-MM-dd", or "" when there is no due date. */
    fun dayString(date: LocalDate?): String = date?.format(DAY) ?: ""

    /** Parses "yyyy-MM-dd". Returns null for blank or malformed input. */
    fun parseDay(value: String?): LocalDate? {
        if (value.isNullOrBlank()) return null
        return runCatching { LocalDate.parse(value, DAY) }.getOrNull()
    }

    fun iso(instant: Instant?): String? = instant?.toString()

    /** Parses ISO-8601, with or without fractional seconds. */
    fun parseIso(value: String?): Instant? {
        if (value.isNullOrBlank()) return null
        return runCatching { Instant.parse(value) }.getOrNull()
    }

    // --- display ---------------------------------------------------------

    /**
     * "today" / "tomorrow" / "yesterday" / "in 3d" / "4d ago" / "12 Sep".
     * Matches the wording used on iOS and the web.
     */
    fun label(date: LocalDate, today: LocalDate = LocalDate.now()): String {
        val days = ChronoUnit.DAYS.between(today, date)
        return when {
            days == 0L -> "today"
            days == 1L -> "tomorrow"
            days == -1L -> "yesterday"
            days in 2..7 -> "in ${days}d"
            days < -1 -> "${-days}d ago"
            else -> date.format(DateTimeFormatter.ofPattern("d MMM"))
        }
    }

    fun greeting(hour: Int): String = when {
        hour < 12 -> "Good morning"
        hour < 17 -> "Good afternoon"
        else -> "Good evening"
    }

    fun today(zone: ZoneId = ZoneId.systemDefault()): LocalDate = LocalDate.now(zone)
}
