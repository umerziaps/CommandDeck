package com.umerzia.commanddeck.model

/**
 * Which items the board is currently showing.
 */
sealed interface CategoryFilter {
    data object All : CategoryFilter
    data object Uncategorized : CategoryFilter
    data class Category(val id: String) : CategoryFilter

    fun matches(item: Item): Boolean = when (this) {
        All -> true
        Uncategorized -> item.catId.isEmpty()
        is Category -> item.catId == id
    }
}
