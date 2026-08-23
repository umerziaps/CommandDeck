package com.umerzia.commanddeck

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.umerzia.commanddeck.data.AuthManager
import com.umerzia.commanddeck.data.DeckRepository
import com.umerzia.commanddeck.model.Bucket
import com.umerzia.commanddeck.model.CategoryFilter
import com.umerzia.commanddeck.model.Item
import com.umerzia.commanddeck.model.ItemCategory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Wires auth to the repository and holds the small amount of state that is
 * genuinely UI-only (which filter is active, whether a sheet is open).
 * Everything else lives in Firestore.
 */
class DeckViewModel(app: Application) : AndroidViewModel(app) {

    val auth = AuthManager(app)
    val repo = DeckRepository()

    val items: StateFlow<List<Item>> get() = repo.items
    val categories: StateFlow<List<ItemCategory>> get() = repo.categories

    private val _filter = MutableStateFlow<CategoryFilter>(CategoryFilter.All)
    val filter: StateFlow<CategoryFilter> = _filter.asStateFlow()

    private val _signInError = MutableStateFlow<String?>(null)
    val signInError: StateFlow<String?> = _signInError.asStateFlow()

    private val _isSigningIn = MutableStateFlow(false)
    val isSigningIn: StateFlow<Boolean> = _isSigningIn.asStateFlow()

    init {
        viewModelScope.launch {
            auth.user.collect { user ->
                if (user != null) repo.start(user.uid) else repo.stop()
            }
        }
    }

    // --- auth ------------------------------------------------------------

    fun signIn(activityContext: Context, serverClientId: String) {
        viewModelScope.launch {
            _isSigningIn.value = true
            _signInError.value = null
            val result = auth.signInWithGoogle(activityContext, serverClientId)
            result.exceptionOrNull()?.let { _signInError.value = it.localizedMessage ?: it.toString() }
            _isSigningIn.value = false
        }
    }

    fun signOut() = auth.signOut()

    // --- board -----------------------------------------------------------

    fun setFilter(filter: CategoryFilter) {
        // Tapping the active chip clears the filter.
        _filter.value = if (_filter.value == filter) CategoryFilter.All else filter
    }

    fun visibleItems(bucket: Bucket): List<Item> =
        items.value
            .filter { !it.done && it.bucket == bucket && _filter.value.matches(it) }
            .sortedWith(Item.boardOrder)

    fun doneItems(): List<Item> =
        items.value
            .filter { it.done && _filter.value.matches(it) }
            .sortedByDescending { it.doneAt }

    fun capture(title: String) {
        val preset = (_filter.value as? CategoryFilter.Category)?.id ?: ""
        repo.capture(title, preset)
    }

    fun deleteCategory(category: ItemCategory) {
        viewModelScope.launch { repo.deleteCategory(category) }
    }
}
