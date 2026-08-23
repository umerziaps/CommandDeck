package com.umerzia.commanddeck.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.CheckBoxOutlineBlank
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PriorityHigh
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.umerzia.commanddeck.DeckViewModel
import com.umerzia.commanddeck.model.Bucket
import com.umerzia.commanddeck.model.CategoryFilter
import com.umerzia.commanddeck.model.DeckDate
import com.umerzia.commanddeck.model.Item
import com.umerzia.commanddeck.ui.theme.bucketColors
import com.umerzia.commanddeck.ui.theme.signalColor
import java.time.LocalDate

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeckScreen(vm: DeckViewModel) {

    val items by vm.items.collectAsState()
    val categories by vm.categories.collectAsState()
    val filter by vm.filter.collectAsState()
    val loading by vm.repo.isLoading.collectAsState()
    val error by vm.repo.error.collectAsState()
    val pending by vm.repo.pendingWrites.collectAsState()

    var captureText by remember { mutableStateOf("") }
    var menuOpen by remember { mutableStateOf(false) }
    var detailFor by remember { mutableStateOf<String?>(null) }
    var showCategories by remember { mutableStateOf(false) }

    val (nowColor, waitingColor, laterColor) = bucketColors()
    val signal = signalColor()
    fun accent(bucket: Bucket) = when (bucket) {
        Bucket.NOW -> nowColor
        Bucket.WAITING -> waitingColor
        Bucket.LATER -> laterColor
    }

    val today = remember { LocalDate.now() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Command Deck") },
                actions = {
                    if (pending) {
                        Icon(
                            Icons.Default.CloudOff,
                            contentDescription = "Saving",
                            tint = laterColor,
                            modifier = Modifier.size(20.dp)
                        )
                    }
                    IconButton(onClick = { menuOpen = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = "Menu")
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text("Categories") },
                            onClick = { menuOpen = false; showCategories = true }
                        )
                        DropdownMenuItem(
                            text = { Text("Sign out") },
                            onClick = { menuOpen = false; vm.signOut() }
                        )
                    }
                }
            )
        },
        bottomBar = {
            CaptureBar(
                value = captureText,
                onValueChange = { captureText = it },
                onSubmit = {
                    vm.capture(captureText)
                    captureText = ""
                }
            )
        }
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {

            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())

            error?.let {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { vm.repo.clearError() }
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                )
            }

            // Category filter chips
            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    horizontal = 16.dp, vertical = 8.dp
                )
            ) {
                val active = items.filter { !it.done }
                item {
                    FilterChip(
                        selected = filter is CategoryFilter.All,
                        onClick = { vm.setFilter(CategoryFilter.All) },
                        label = { Text("All ${active.size}") }
                    )
                }
                items(categories, key = { it.id }) { category ->
                    val count = active.count { it.catId == category.id }
                    FilterChip(
                        selected = filter == CategoryFilter.Category(category.id),
                        onClick = { vm.setFilter(CategoryFilter.Category(category.id)) },
                        label = { Text("${category.name} $count") },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = hexColor(category.colorHex)
                        )
                    )
                }
                item {
                    val loose = active.count { it.catId.isEmpty() }
                    if (loose > 0) {
                        FilterChip(
                            selected = filter is CategoryFilter.Uncategorized,
                            onClick = { vm.setFilter(CategoryFilter.Uncategorized) },
                            label = { Text("Uncategorized $loose") }
                        )
                    }
                }
            }

            LazyColumn(Modifier.fillMaxSize()) {

                item {
                    Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp)) {
                        Text(
                            DeckDate.greeting(java.time.LocalTime.now().hour),
                            style = MaterialTheme.typography.headlineSmall,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            today.toString(),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.outline
                        )
                    }
                }

                Bucket.entries.forEach { bucket ->
                    val bucketItems = vm.visibleItems(bucket)

                    item(key = "header-${bucket.wire}") {
                        SectionHeader(bucket.title, bucketItems.size, accent(bucket))
                    }

                    if (bucketItems.isEmpty()) {
                        item(key = "empty-${bucket.wire}") {
                            Text(
                                bucket.emptyMessage,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.outline,
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                            )
                        }
                    } else {
                        items(bucketItems, key = { it.id }) { item ->
                            ItemRow(
                                item = item,
                                categoryColor = vm.repo.category(item.catId)?.colorHex,
                                categoryName = vm.repo.category(item.catId)?.name,
                                accent = if (item.urgent) signal else accent(bucket),
                                today = today,
                                onToggleDone = { vm.repo.toggleDone(item) },
                                onToggleUrgent = { vm.repo.toggleUrgent(item) },
                                onOpen = { detailFor = item.id }
                            )
                        }
                    }
                }

                val done = vm.doneItems()
                if (done.isNotEmpty()) {
                    item(key = "header-done") {
                        SectionHeader("Done", done.size, MaterialTheme.colorScheme.outline)
                    }
                    items(done.take(50), key = { it.id }) { item ->
                        ItemRow(
                            item = item,
                            categoryColor = vm.repo.category(item.catId)?.colorHex,
                            categoryName = vm.repo.category(item.catId)?.name,
                            accent = MaterialTheme.colorScheme.outline,
                            today = today,
                            onToggleDone = { vm.repo.toggleDone(item) },
                            onToggleUrgent = { vm.repo.toggleUrgent(item) },
                            onOpen = { detailFor = item.id }
                        )
                    }
                }

                item { Spacer(Modifier.height(24.dp)) }
            }
        }
    }

    // Sheets
    detailFor?.let { id ->
        items.firstOrNull { it.id == id }?.let { item ->
            ItemDetailSheet(
                vm = vm,
                item = item,
                onDismiss = { detailFor = null }
            )
        } ?: run { detailFor = null }
    }

    if (showCategories) {
        CategorySheet(vm = vm, onDismiss = { showCategories = false })
    }
}

@Composable
private fun SectionHeader(title: String, count: Int, accent: Color) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 6.dp)
    ) {
        Box(Modifier.size(9.dp).background(accent, CircleShape))
        Spacer(Modifier.width(9.dp))
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        Spacer(Modifier.width(8.dp))
        Text(
            "$count",
            style = MaterialTheme.typography.labelSmall,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.outline
        )
    }
}

@Composable
private fun ItemRow(
    item: Item,
    categoryColor: String?,
    categoryName: String?,
    accent: Color,
    today: LocalDate,
    onToggleDone: () -> Unit,
    onToggleUrgent: () -> Unit,
    onOpen: () -> Unit
) {
    Row(
        verticalAlignment = Alignment.Top,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(12.dp))
            .clickable(onClick = onOpen)
            .padding(12.dp)
    ) {
        // Left accent edge
        Box(
            Modifier
                .width(3.dp)
                .height(36.dp)
                .background(accent, RoundedCornerShape(2.dp))
        )
        Spacer(Modifier.width(10.dp))

        IconButton(onClick = onToggleDone, modifier = Modifier.size(24.dp)) {
            Icon(
                if (item.done) Icons.Default.CheckBox else Icons.Default.CheckBoxOutlineBlank,
                contentDescription = if (item.done) "Mark not done" else "Mark done",
                tint = if (item.done) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.outline
            )
        }

        Spacer(Modifier.width(10.dp))

        Column(Modifier.weight(1f)) {
            Text(
                item.title,
                style = MaterialTheme.typography.bodyLarge,
                textDecoration = if (item.done) TextDecoration.LineThrough else null,
                color = if (item.done) MaterialTheme.colorScheme.outline
                else MaterialTheme.colorScheme.onSurface
            )

            val chips = buildList {
                if (categoryName != null) add(categoryName)
                if (item.bucket == Bucket.WAITING && item.waitingOn.isNotEmpty()) {
                    add("waiting on ${item.waitingOn}")
                }
                item.due?.let { add(DeckDate.label(it, today)) }
                if (item.subs.isNotEmpty()) add("${item.doneSubCount}/${item.subs.size}")
            }
            if (chips.isNotEmpty()) {
                Text(
                    chips.joinToString("  ·  "),
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                    color = categoryColor?.let { hexColor(it) }
                        ?: MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp)
                )
            }
        }

        IconButton(onClick = onToggleUrgent, modifier = Modifier.size(24.dp)) {
            Icon(
                Icons.Default.PriorityHigh,
                contentDescription = if (item.urgent) "Clear urgent" else "Mark urgent",
                tint = if (item.urgent) signalColor() else MaterialTheme.colorScheme.outline
            )
        }
    }
}

@Composable
private fun CaptureBar(
    value: String,
    onValueChange: (String) -> Unit,
    onSubmit: () -> Unit
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface)
            .padding(horizontal = 12.dp, vertical = 8.dp)
    ) {
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            placeholder = { Text("Capture anything…") },
            singleLine = true,
            modifier = Modifier.weight(1f),
            shape = RoundedCornerShape(14.dp),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { onSubmit() })
        )
        Spacer(Modifier.width(8.dp))
        IconButton(
            onClick = onSubmit,
            enabled = value.isNotBlank()
        ) {
            Icon(Icons.Default.Add, contentDescription = "Add", tint = MaterialTheme.colorScheme.primary)
        }
    }
}

/** Parses "#RRGGBB" into a Compose colour, falling back to grey. */
internal fun hexColor(hex: String): Color = runCatching {
    Color(android.graphics.Color.parseColor(hex))
}.getOrDefault(Color.Gray)
