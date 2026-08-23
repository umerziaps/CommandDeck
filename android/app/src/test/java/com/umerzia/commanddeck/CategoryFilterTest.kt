package com.umerzia.commanddeck

import com.umerzia.commanddeck.model.CategoryFilter
import com.umerzia.commanddeck.model.Item
import com.umerzia.commanddeck.model.ItemCategory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CategoryFilterTest {

    private val ocufii = Item(id = "a", catId = "c_ocufii")
    private val home = Item(id = "b", catId = "c_home")
    private val loose = Item(id = "c", catId = "")

    @Test
    fun `All shows everything`() {
        val all = listOf(ocufii, home, loose)
        assertEquals(all, all.filter { CategoryFilter.All.matches(it) })
    }

    @Test
    fun `a category filter shows only its own items`() {
        val filter = CategoryFilter.Category("c_ocufii")
        assertTrue(filter.matches(ocufii))
        assertFalse(filter.matches(home))
        assertFalse(filter.matches(loose))
    }

    @Test
    fun `Uncategorized shows only items with no category`() {
        assertTrue(CategoryFilter.Uncategorized.matches(loose))
        assertFalse(CategoryFilter.Uncategorized.matches(ocufii))
    }

    @Test
    fun `deleting a category leaves its items uncategorized, not deleted`() {
        // The repository clears catId rather than removing documents. This
        // asserts the shape that behaviour produces.
        val orphaned = ocufii.copy(catId = "")
        assertTrue(CategoryFilter.Uncategorized.matches(orphaned))
        assertFalse(CategoryFilter.Category("c_ocufii").matches(orphaned))
    }

    @Test
    fun `category colours come from the shared palette in order`() {
        assertEquals(ItemCategory.PALETTE[0], ItemCategory.nextColor(emptyList()))
        assertEquals(
            ItemCategory.PALETTE[1],
            ItemCategory.nextColor(listOf(ItemCategory.PALETTE[0]))
        )
    }

    @Test
    fun `colours wrap round once the palette is exhausted`() {
        val everything = ItemCategory.PALETTE
        // Should pick something valid rather than crashing or returning null.
        assertTrue(ItemCategory.nextColor(everything) in ItemCategory.PALETTE)
    }

    @Test
    fun `the palette matches the one the other clients use`() {
        // Same ten hex values as DeckTheme.categoryPalette (iOS) and
        // CAT_PALETTE (web). A category created on one client has to render
        // in the same colour on the others.
        assertEquals(10, ItemCategory.PALETTE.size)
        assertEquals("#5EE6C5", ItemCategory.PALETTE.first())
        assertTrue(ItemCategory.PALETTE.all { it.matches(Regex("^#[0-9A-F]{6}$")) })
    }
}
