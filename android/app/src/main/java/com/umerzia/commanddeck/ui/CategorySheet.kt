package com.umerzia.commanddeck.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.umerzia.commanddeck.DeckViewModel
import com.umerzia.commanddeck.model.ItemCategory

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun CategorySheet(vm: DeckViewModel, onDismiss: () -> Unit) {

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val categories by vm.categories.collectAsState()
    val items by vm.items.collectAsState()

    var newName by remember { mutableStateOf("") }
    var duplicate by remember { mutableStateOf(false) }
    var pendingDelete by remember { mutableStateOf<ItemCategory?>(null) }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 32.dp)
        ) {
            Text("Categories", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)

            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(top = 12.dp)
            ) {
                OutlinedTextField(
                    value = newName,
                    onValueChange = { newName = it; duplicate = false },
                    placeholder = { Text("New category") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                    isError = duplicate,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = {
                        if (vm.repo.addCategory(newName)) newName = "" else duplicate = true
                    })
                )
                Spacer(Modifier.width(8.dp))
                TextButton(
                    onClick = {
                        if (vm.repo.addCategory(newName)) newName = "" else duplicate = true
                    },
                    enabled = newName.isNotBlank()
                ) { Text("Add") }
            }

            if (duplicate) {
                Text(
                    "A category with that name already exists.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error
                )
            }

            Spacer(Modifier.height(8.dp))
            HorizontalDivider()

            if (categories.isEmpty()) {
                Text(
                    "No categories yet. Items you file under one get its colour on the board.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.outline,
                    modifier = Modifier.padding(vertical = 16.dp)
                )
            }

            categories.forEach { category ->
                val count = items.count { it.catId == category.id }
                var name by remember(category.id) { mutableStateOf(category.name) }

                Column(Modifier.padding(vertical = 12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            Modifier
                                .size(14.dp)
                                .background(hexColor(category.colorHex), CircleShape)
                        )
                        Spacer(Modifier.width(10.dp))
                        OutlinedTextField(
                            value = name,
                            onValueChange = { name = it },
                            singleLine = true,
                            modifier = Modifier.weight(1f),
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                            keyboardActions = KeyboardActions(onDone = {
                                vm.repo.renameCategory(category, name)
                            })
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            "$count",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.outline
                        )
                        IconButton(onClick = { pendingDelete = category }) {
                            Icon(
                                Icons.Default.Delete,
                                contentDescription = "Delete category",
                                tint = MaterialTheme.colorScheme.error
                            )
                        }
                    }

                    // Colour swatches
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        modifier = Modifier.padding(top = 8.dp)
                    ) {
                        ItemCategory.PALETTE.forEach { hex ->
                            val selected = category.colorHex.equals(hex, ignoreCase = true)
                            Box(
                                Modifier
                                    .size(26.dp)
                                    .background(hexColor(hex), RoundedCornerShape(7.dp))
                                    .clickable { vm.repo.recolorCategory(category, hex) }
                                    .padding(3.dp)
                                    .background(
                                        if (selected) Color.White.copy(alpha = 0.9f)
                                        else Color.Transparent,
                                        RoundedCornerShape(4.dp)
                                    )
                            )
                        }
                    }
                }
                HorizontalDivider()
            }

            pendingDelete?.let { category ->
                val affected = items.count { it.catId == category.id }
                Column(Modifier.padding(top = 16.dp)) {
                    Text(
                        "Delete \"${category.name}\"? " +
                            if (affected > 0) {
                                "$affected item${if (affected == 1) "" else "s"} become " +
                                    "uncategorized — nothing is deleted."
                            } else "It isn't used by any item.",
                        style = MaterialTheme.typography.bodySmall
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { pendingDelete = null }) { Text("Cancel") }
                        TextButton(onClick = {
                            vm.deleteCategory(category)
                            pendingDelete = null
                        }) {
                            Text("Delete", color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        }
    }
}
