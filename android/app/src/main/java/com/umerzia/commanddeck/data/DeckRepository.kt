package com.umerzia.commanddeck.data

import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.ListenerRegistration
import com.umerzia.commanddeck.model.Bucket
import com.umerzia.commanddeck.model.Item
import com.umerzia.commanddeck.model.ItemCategory
import com.umerzia.commanddeck.model.SubTask
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.tasks.await
import java.time.Instant

/**
 * The board's live view of Firestore.
 *
 * Two snapshot listeners keep [items] and [categories] current; every
 * mutation writes straight to Firestore and the listener echoes it back, so
 * there is no second source of truth to keep in sync.
 *
 * Firestore's offline cache is on by default on Android, which means reads
 * work with no signal and writes queue up and flush on reconnect. That's
 * why the mutating functions don't suspend — the local cache applies them
 * immediately and the listener fires straight away.
 */
class DeckRepository(private val db: FirebaseFirestore = FirebaseFirestore.getInstance()) {

    private val _items = MutableStateFlow<List<Item>>(emptyList())
    val items: StateFlow<List<Item>> = _items.asStateFlow()

    private val _categories = MutableStateFlow<List<ItemCategory>>(emptyList())
    val categories: StateFlow<List<ItemCategory>> = _categories.asStateFlow()

    private val _isLoading = MutableStateFlow(true)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _pendingWrites = MutableStateFlow(false)
    val pendingWrites: StateFlow<Boolean> = _pendingWrites.asStateFlow()

    private var itemsListener: ListenerRegistration? = null
    private var catsListener: ListenerRegistration? = null
    private var uid: String? = null

    private fun itemsCol() = db.collection("users").document(uid!!).collection("items")
    private fun catsCol() = db.collection("users").document(uid!!).collection("categories")

    // --- lifecycle -------------------------------------------------------

    fun start(uid: String) {
        if (this.uid == uid) return
        stop()
        this.uid = uid
        _isLoading.value = true

        itemsListener = itemsCol().addSnapshotListener { snapshot, error ->
            if (error != null) {
                _error.value = describe(error)
                _isLoading.value = false
                return@addSnapshotListener
            }
            if (snapshot == null) return@addSnapshotListener

            _items.value = snapshot.documents.mapNotNull { doc ->
                doc.data?.let { Item.fromMap(doc.id, it) }
            }
            _pendingWrites.value = snapshot.metadata.hasPendingWrites()
            _isLoading.value = false
        }

        catsListener = catsCol().addSnapshotListener { snapshot, error ->
            if (error != null) {
                _error.value = describe(error)
                return@addSnapshotListener
            }
            if (snapshot == null) return@addSnapshotListener

            _categories.value = snapshot.documents
                .mapNotNull { doc -> doc.data?.let { ItemCategory.fromMap(doc.id, it) } }
                .sortedBy { it.createdAt }
        }
    }

    fun stop() {
        itemsListener?.remove(); itemsListener = null
        catsListener?.remove(); catsListener = null
        uid = null
        _items.value = emptyList()
        _categories.value = emptyList()
        _isLoading.value = false
    }

    fun clearError() { _error.value = null }

    private fun describe(e: FirebaseFirestoreException): String =
        if (e.code == FirebaseFirestoreException.Code.PERMISSION_DENIED) {
            "Permission denied. Check the Firestore rules in firestore.rules are published."
        } else {
            e.localizedMessage ?: e.toString()
        }

    // --- reads -----------------------------------------------------------

    fun category(id: String): ItemCategory? = _categories.value.firstOrNull { it.id == id }

    // --- item writes -----------------------------------------------------

    fun capture(title: String, catId: String = "") {
        val trimmed = title.trim()
        if (trimmed.isEmpty() || uid == null) return

        val item = Item(
            title = trimmed,
            bucket = Bucket.LATER,
            catId = catId,
            order = Item.nextOrder(Bucket.LATER, _items.value),
            createdAt = Instant.now()
        )
        itemsCol().document(item.id).set(item.toMap()).addOnFailureListener(::report)
    }

    private fun patch(id: String, fields: Map<String, Any?>) {
        if (uid == null) return
        itemsCol().document(id).update(fields).addOnFailureListener(::report)
    }

    fun toggleDone(item: Item) {
        val nowDone = !item.done
        patch(
            item.id,
            mapOf(
                "done" to nowDone,
                "doneAt" to if (nowDone) Instant.now().toString() else null
            )
        )
    }

    /**
     * Turning urgent on lifts the item to the top of its bucket once.
     * Turning it off leaves it where it is — no surprise jumps.
     */
    fun toggleUrgent(item: Item) {
        val fields = mutableMapOf<String, Any?>("urgent" to !item.urgent)
        if (!item.urgent) {
            fields["order"] = Item.liftedOrder(item, _items.value)
        }
        patch(item.id, fields)
    }

    fun move(item: Item, bucket: Bucket) {
        if (item.bucket == bucket) return
        patch(
            item.id,
            mapOf(
                "bucket" to bucket.wire,
                "order" to Item.nextOrder(bucket, _items.value),
                "waitingOn" to if (bucket == Bucket.WAITING) item.waitingOn else ""
            )
        )
    }

    fun setTitle(item: Item, title: String) {
        val trimmed = title.trim()
        if (trimmed.isEmpty() || trimmed == item.title) return
        patch(item.id, mapOf("title" to trimmed))
    }

    fun setDue(item: Item, due: java.time.LocalDate?) =
        patch(item.id, mapOf("due" to com.umerzia.commanddeck.model.DeckDate.dayString(due)))

    fun setCategory(item: Item, catId: String) = patch(item.id, mapOf("catId" to catId))

    fun setWaitingOn(item: Item, who: String) = patch(item.id, mapOf("waitingOn" to who))

    fun delete(item: Item) {
        if (uid == null) return
        itemsCol().document(item.id).delete().addOnFailureListener(::report)
    }

    // --- sub-tasks -------------------------------------------------------

    fun addSubtask(item: Item, text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        val subs = item.subs + SubTask(text = trimmed)
        patch(item.id, mapOf("subs" to subs.map { it.toMap() }))
    }

    fun toggleSubtask(item: Item, sub: SubTask) {
        val subs = item.subs.map { if (it.id == sub.id) it.copy(done = !it.done) else it }
        patch(item.id, mapOf("subs" to subs.map { it.toMap() }))
    }

    fun deleteSubtask(item: Item, sub: SubTask) {
        val subs = item.subs.filterNot { it.id == sub.id }
        patch(item.id, mapOf("subs" to subs.map { it.toMap() }))
    }

    // --- categories ------------------------------------------------------

    fun addCategory(name: String): Boolean {
        val trimmed = name.trim()
        if (trimmed.isEmpty() || uid == null) return false
        if (_categories.value.any { it.name.equals(trimmed, ignoreCase = true) }) return false

        val category = ItemCategory(
            name = trimmed,
            colorHex = ItemCategory.nextColor(_categories.value.map { it.colorHex }),
            createdAt = Instant.now()
        )
        catsCol().document(category.id).set(category.toMap()).addOnFailureListener(::report)
        return true
    }

    fun renameCategory(category: ItemCategory, name: String) {
        val trimmed = name.trim()
        if (trimmed.isEmpty() || trimmed == category.name || uid == null) return
        catsCol().document(category.id).update("name", trimmed).addOnFailureListener(::report)
    }

    fun recolorCategory(category: ItemCategory, hex: String) {
        if (uid == null) return
        catsCol().document(category.id).update("color", hex).addOnFailureListener(::report)
    }

    /** Items outlive their category — they just become uncategorized. */
    suspend fun deleteCategory(category: ItemCategory) {
        if (uid == null) return
        try {
            val batch = db.batch()
            _items.value.filter { it.catId == category.id }.forEach {
                batch.update(itemsCol().document(it.id), "catId", "")
            }
            batch.delete(catsCol().document(category.id))
            batch.commit().await()
        } catch (e: Exception) {
            _error.value = e.localizedMessage ?: e.toString()
        }
    }

    private fun report(e: Exception) {
        _error.value = (e as? FirebaseFirestoreException)?.let(::describe)
            ?: e.localizedMessage
            ?: e.toString()
    }
}
