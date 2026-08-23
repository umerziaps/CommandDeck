package com.umerzia.commanddeck

import com.umerzia.commanddeck.model.Bucket
import com.umerzia.commanddeck.model.Item
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/**
 * Covers how the board decides what sits where.
 *
 * The rules are small but they're the ones a user notices immediately when
 * they're wrong — an item that jumps, or a newly captured task landing at
 * the top instead of the bottom.
 */
class BoardOrderTest {

    private fun item(
        id: String,
        order: Int,
        bucket: Bucket = Bucket.NOW,
        done: Boolean = false,
        createdAt: String = "2026-08-01T00:00:00Z"
    ) = Item(
        id = id,
        title = id,
        bucket = bucket,
        done = done,
        order = order,
        createdAt = Instant.parse(createdAt)
    )

    @Test
    fun `sorts by manual order first`() {
        val sorted = listOf(item("c", 2), item("a", 0), item("b", 1))
            .sortedWith(Item.boardOrder)

        assertEquals(listOf("a", "b", "c"), sorted.map { it.id })
    }

    @Test
    fun `breaks ties with the newest capture first`() {
        val older = item("older", 0, createdAt = "2026-08-01T00:00:00Z")
        val newer = item("newer", 0, createdAt = "2026-08-20T00:00:00Z")

        val sorted = listOf(older, newer).sortedWith(Item.boardOrder)
        assertEquals(listOf("newer", "older"), sorted.map { it.id })
    }

    @Test
    fun `does NOT float urgent items to the top on every read`() {
        // The original web version re-sorted urgent items to the top on each
        // render, which fights drag-to-reorder: an item dragged above an
        // urgent one visibly snaps back. Urgency is a one-time lift now.
        val urgentAtBottom = item("urgent", 5).copy(urgent = true)
        val calm = item("calm", 0)

        val sorted = listOf(urgentAtBottom, calm).sortedWith(Item.boardOrder)
        assertEquals(listOf("calm", "urgent"), sorted.map { it.id })
    }

    @Test
    fun `marking urgent lifts the item above everything in its bucket`() {
        val all = listOf(item("a", 0), item("b", 1), item("c", 2))
        val lifted = Item.liftedOrder(all[2], all)

        assertTrue("expected $lifted to sort above 0", lifted < 0)

        val reordered = all.map { if (it.id == "c") it.copy(order = lifted) else it }
            .sortedWith(Item.boardOrder)
        assertEquals(listOf("c", "a", "b"), reordered.map { it.id })
    }

    @Test
    fun `the lift only considers the same bucket`() {
        val all = listOf(
            item("now-1", 0, bucket = Bucket.NOW),
            item("later-1", -50, bucket = Bucket.LATER)
        )
        // The Later item's very low order must not drag the Now item's
        // lift down with it.
        assertEquals(-1, Item.liftedOrder(all[0], all))
    }

    @Test
    fun `the lift ignores completed items`() {
        val all = listOf(
            item("done-one", -99, done = true),
            item("open-one", 0)
        )
        assertEquals(-1, Item.liftedOrder(all[1], all))
    }

    @Test
    fun `newly captured items go to the bottom of the bucket`() {
        val all = listOf(item("a", 0, Bucket.LATER), item("b", 1, Bucket.LATER))
        assertEquals(2, Item.nextOrder(Bucket.LATER, all))
    }

    @Test
    fun `the first item in an empty bucket gets order zero`() {
        assertEquals(0, Item.nextOrder(Bucket.NOW, emptyList()))
        assertEquals(0, Item.nextOrder(Bucket.NOW, listOf(item("l", 4, Bucket.LATER))))
    }

    @Test
    fun `completed items do not affect where the next capture lands`() {
        val all = listOf(
            item("old", 99, Bucket.LATER, done = true),
            item("live", 0, Bucket.LATER)
        )
        assertEquals(1, Item.nextOrder(Bucket.LATER, all))
    }
}
