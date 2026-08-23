package com.umerzia.commanddeck.model

import java.time.Instant
import java.time.LocalDate
import java.time.temporal.ChronoUnit
import java.util.UUID

/**
 * A card on the board.
 *
 * Deliberately free of Android and Firebase types: [fromMap] takes a plain
 * `Map`, which is what a Firestore snapshot hands over anyway. That keeps
 * this class — and the tests covering it — runnable on a plain JVM, so CI
 * needs no emulator to check the logic that actually matters.
 */
data class Item(
    val id: String = UUID.randomUUID().toString(),
    val title: String = "",
    val bucket: Bucket = Bucket.LATER,
    val done: Boolean = false,
    val doneAt: Instant? = null,
    val waitingOn: String = "",
    val due: LocalDate? = null,
    val subs: List<SubTask> = emptyList(),
    val catId: String = "",
    val urgent: Boolean = false,
    /** Manual priority inside a bucket. */
    val order: Int = 0,
    val createdAt: Instant = Instant.EPOCH
) {
    val openSubCount: Int get() = subs.count { !it.done }
    val doneSubCount: Int get() = subs.count { it.done }

    fun isOverdue(today: LocalDate = DeckDate.today()): Boolean =
        due != null && !done && due.isBefore(today)

    fun isDueSoon(today: LocalDate = DeckDate.today()): Boolean =
        due != null && !done && ChronoUnit.DAYS.between(today, due) <= 2

    // --- wire format ------------------------------------------------------
    //
    // Field names here MUST match docs/app.js (see its SCHEMA comment) and
    // CommandDeck/Models/Item.swift. A typo in either direction shows up as
    // silently missing data rather than an error, which is exactly why
    // ItemMappingTest exists.

    fun toMap(): Map<String, Any?> = mapOf(
        "title" to title,
        "bucket" to bucket.wire,
        "done" to done,
        "doneAt" to DeckDate.iso(doneAt),
        "waitingOn" to waitingOn,
        "due" to DeckDate.dayString(due),
        "subs" to subs.map { it.toMap() },
        "catId" to catId,
        "urgent" to urgent,
        "order" to order,
        "createdAt" to (DeckDate.iso(createdAt) ?: Instant.now().toString())
    )

    companion object {
        /**
         * Rebuilds an item from a Firestore document. Every field falls back
         * to a sensible default so a document written by an older client —
         * or a half-written one — still loads.
         */
        fun fromMap(id: String, raw: Map<String, Any?>): Item = Item(
            id = id,
            title = raw["title"] as? String ?: "",
            bucket = Bucket.fromWire(raw["bucket"] as? String),
            done = raw["done"] as? Boolean ?: false,
            doneAt = DeckDate.parseIso(raw["doneAt"] as? String),
            waitingOn = raw["waitingOn"] as? String ?: "",
            due = DeckDate.parseDay(raw["due"] as? String),
            subs = (raw["subs"] as? List<*>)
                ?.mapNotNull { (it as? Map<*, *>)?.let(SubTask::fromMap) }
                ?: emptyList(),
            catId = raw["catId"] as? String ?: "",
            urgent = raw["urgent"] as? Boolean ?: false,
            // Firestore hands numbers back as Long, so go via Number.
            order = (raw["order"] as? Number)?.toInt() ?: 0,
            createdAt = DeckDate.parseIso(raw["createdAt"] as? String) ?: Instant.EPOCH
        )

        /**
         * The board's sort rule: manual order first, newest capture as the
         * tie-break.
         *
         * Note what this does NOT do — float urgent items to the top on
         * every read. The web version used to, and it fights manual
         * reordering. Instead, marking an item urgent lifts it once (see
         * [liftedOrder]) and then leaves you in control.
         */
        val boardOrder: Comparator<Item> =
            compareBy<Item> { it.order }.thenByDescending { it.createdAt }

        /**
         * The order value that puts [item] at the top of its bucket.
         * Used when an item is marked urgent.
         */
        fun liftedOrder(item: Item, all: List<Item>): Int {
            val peers = all.filter {
                it.bucket == item.bucket && !it.done && it.id != item.id
            }
            return (peers.minOfOrNull { it.order } ?: 0) - 1
        }

        /** The order value for a newly captured item in [bucket]. */
        fun nextOrder(bucket: Bucket, all: List<Item>): Int {
            val peers = all.filter { it.bucket == bucket && !it.done }
            return (peers.maxOfOrNull { it.order } ?: -1) + 1
        }
    }
}
