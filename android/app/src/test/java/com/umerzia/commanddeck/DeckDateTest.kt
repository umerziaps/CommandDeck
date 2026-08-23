package com.umerzia.commanddeck

import com.umerzia.commanddeck.model.DeckDate
import com.umerzia.commanddeck.model.Item
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate

/**
 * Covers date formatting and parsing.
 *
 * Note that every case passes "today" in explicitly. A test that depends on
 * the real clock passes in the morning and fails at midnight — the kind of
 * flake that erodes trust in a whole test suite.
 */
class DeckDateTest {

    private val today = LocalDate.of(2026, 8, 22)

    @Test
    fun `labels the days around today in words`() {
        assertEquals("today", DeckDate.label(today, today))
        assertEquals("tomorrow", DeckDate.label(today.plusDays(1), today))
        assertEquals("yesterday", DeckDate.label(today.minusDays(1), today))
    }

    @Test
    fun `labels the coming week as a countdown`() {
        assertEquals("in 2d", DeckDate.label(today.plusDays(2), today))
        assertEquals("in 7d", DeckDate.label(today.plusDays(7), today))
    }

    @Test
    fun `labels the past as elapsed days`() {
        assertEquals("5d ago", DeckDate.label(today.minusDays(5), today))
    }

    @Test
    fun `falls back to a calendar date beyond a week out`() {
        assertEquals("14 Sep", DeckDate.label(LocalDate.of(2026, 9, 14), today))
    }

    @Test
    fun `day strings round trip`() {
        val date = LocalDate.of(2026, 9, 14)
        assertEquals("2026-09-14", DeckDate.dayString(date))
        assertEquals(date, DeckDate.parseDay("2026-09-14"))
    }

    @Test
    fun `no due date is an empty string, and empty parses back to null`() {
        assertEquals("", DeckDate.dayString(null))
        assertNull(DeckDate.parseDay(""))
        assertNull(DeckDate.parseDay(null))
    }

    @Test
    fun `malformed dates return null instead of throwing`() {
        // A bad value in one document must not take down the whole board.
        assertNull(DeckDate.parseDay("not-a-date"))
        assertNull(DeckDate.parseDay("14/09/2026"))
        assertNull(DeckDate.parseIso("nonsense"))
    }

    @Test
    fun `ISO timestamps round trip`() {
        val instant = Instant.parse("2026-08-22T14:30:00Z")
        assertEquals(instant, DeckDate.parseIso(DeckDate.iso(instant)))
    }

    @Test
    fun `parses ISO timestamps with fractional seconds`() {
        // The web client writes Date.toISOString(), which includes millis.
        assertEquals(
            Instant.parse("2026-08-22T14:30:00.123Z"),
            DeckDate.parseIso("2026-08-22T14:30:00.123Z")
        )
    }

    @Test
    fun `flags overdue and imminent items`() {
        val overdue = Item(due = today.minusDays(1))
        val dueToday = Item(due = today)
        val soon = Item(due = today.plusDays(2))
        val distant = Item(due = today.plusDays(10))

        assertTrue(overdue.isOverdue(today))
        assertTrue(dueToday.isDueSoon(today))
        assertTrue(soon.isDueSoon(today))
        assertFalse(distant.isDueSoon(today))
        assertFalse(dueToday.isOverdue(today))
    }

    @Test
    fun `a completed item is never overdue`() {
        val item = Item(due = today.minusDays(30), done = true)
        assertFalse(item.isOverdue(today))
        assertFalse(item.isDueSoon(today))
    }

    @Test
    fun `greets by time of day`() {
        assertEquals("Good morning", DeckDate.greeting(9))
        assertEquals("Good afternoon", DeckDate.greeting(13))
        assertEquals("Good evening", DeckDate.greeting(20))
    }
}
