package com.umerzia.commanddeck

import com.umerzia.commanddeck.model.Bucket
import com.umerzia.commanddeck.model.Item
import com.umerzia.commanddeck.model.SubTask
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate

/**
 * Covers the Firestore wire format.
 *
 * This is the highest-value test in the project. Three clients — Android,
 * iOS and web — write the same documents, and a mismatched field name
 * doesn't throw: it silently reads back as a default. A task would just
 * quietly lose its due date on one platform. These tests turn that class of
 * bug into a red X in CI.
 */
class ItemMappingTest {

    @Test
    fun `round trips through the wire format without losing anything`() {
        val original = Item(
            id = "i_abc",
            title = "Cut over the EMQX broker",
            bucket = Bucket.NOW,
            done = false,
            doneAt = null,
            waitingOn = "",
            due = LocalDate.of(2026, 9, 14),
            subs = listOf(
                SubTask("s_1", "Snapshot retained topics", done = true),
                SubTask("s_2", "Dry run on staging", done = false)
            ),
            catId = "c_ocufii",
            urgent = true,
            order = 3,
            createdAt = Instant.parse("2026-08-10T09:30:00Z")
        )

        @Suppress("UNCHECKED_CAST")
        val restored = Item.fromMap("i_abc", original.toMap() as Map<String, Any?>)

        assertEquals(original, restored)
    }

    @Test
    fun `uses the exact field names the other clients write`() {
        val map = Item(title = "x").toMap()

        // If you rename any of these, rename them in docs/app.js and
        // CommandDeck/Models/Item.swift in the same commit.
        val expected = setOf(
            "title", "bucket", "done", "doneAt", "waitingOn",
            "due", "subs", "catId", "urgent", "order", "createdAt"
        )
        assertEquals(expected, map.keys)
    }

    @Test
    fun `an empty document loads as a sane Later item rather than throwing`() {
        val item = Item.fromMap("i_empty", emptyMap())

        assertEquals("", item.title)
        assertEquals(Bucket.LATER, item.bucket)
        assertEquals(false, item.done)
        assertNull(item.due)
        assertNull(item.doneAt)
        assertTrue(item.subs.isEmpty())
        assertEquals(0, item.order)
    }

    @Test
    fun `reads order back as Int even though Firestore returns Long`() {
        // Firestore hands every number back as a Long. Casting straight to
        // Int would return null and silently reset the item's position.
        val item = Item.fromMap("i_1", mapOf("order" to 7L))
        assertEquals(7, item.order)
    }

    @Test
    fun `an unknown bucket value falls back to Later instead of crashing`() {
        val item = Item.fromMap("i_1", mapOf("bucket" to "someday-maybe"))
        assertEquals(Bucket.LATER, item.bucket)
    }

    @Test
    fun `an unset due date is written as empty string, not null`() {
        // The web client's date input reads "" for no date; writing null
        // here would make it render "Invalid Date".
        assertEquals("", Item(due = null).toMap()["due"])
        assertEquals("2026-09-14", Item(due = LocalDate.of(2026, 9, 14)).toMap()["due"])
    }

    @Test
    fun `sub-tasks survive the trip as a list of maps`() {
        val item = Item(subs = listOf(SubTask("s_1", "Check the logs", done = true)))

        @Suppress("UNCHECKED_CAST")
        val subs = item.toMap()["subs"] as List<Map<String, Any>>
        assertEquals(1, subs.size)
        assertEquals("Check the logs", subs[0]["text"])
        assertEquals(true, subs[0]["done"])

        @Suppress("UNCHECKED_CAST")
        val restored = Item.fromMap("i_1", item.toMap() as Map<String, Any?>)
        assertEquals(item.subs, restored.subs)
    }

    @Test
    fun `malformed sub-task entries are skipped rather than failing the whole item`() {
        val item = Item.fromMap(
            "i_1",
            mapOf("subs" to listOf(mapOf("id" to "s_1", "text" to "ok", "done" to false), "junk", 42))
        )
        assertEquals(1, item.subs.size)
        assertEquals("ok", item.subs[0].text)
    }

    @Test
    fun `counts open and done sub-tasks`() {
        val item = Item(
            subs = listOf(
                SubTask(text = "a", done = true),
                SubTask(text = "b", done = false),
                SubTask(text = "c", done = false)
            )
        )
        assertEquals(2, item.openSubCount)
        assertEquals(1, item.doneSubCount)
    }
}
