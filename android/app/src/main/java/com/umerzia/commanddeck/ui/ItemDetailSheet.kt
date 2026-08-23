package com.umerzia.commanddeck.ui

import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.umerzia.commanddeck.DeckViewModel
import com.umerzia.commanddeck.model.Bucket
import com.umerzia.commanddeck.model.DeckDate
import com.umerzia.commanddeck.model.Item
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ItemDetailSheet(
    vm: DeckViewModel,
    item: Item,
    onDismiss: () -> Unit
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val categories by vm.categories.collectAsState()

    // Local drafts: typing straight into a value a Firestore listener keeps
    // replacing is unusable, so text commits on done/dismiss instead.
    var title by remember(item.id) { mutableStateOf(item.title) }
    var waitingOn by remember(item.id) { mutableStateOf(item.waitingOn) }
    var newSub by remember(item.id) { mutableStateOf("") }
    var showDatePicker by remember { mutableStateOf(false) }

    fun commitDrafts() {
        vm.repo.setTitle(item, title)
        if (item.bucket == Bucket.WAITING && waitingOn != item.waitingOn) {
            vm.repo.setWaitingOn(item, waitingOn)
        }
    }

    ModalBottomSheet(
        onDismissRequest = { commitDrafts(); onDismiss() },
        sheetState = sheetState
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 32.dp)
        ) {
            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                label = { Text("Title") },
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { vm.repo.setTitle(item, title) })
            )

            Spacer(Modifier.height(16.dp))

            // --- bucket ---
            Text("Bucket", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.padding(top = 8.dp)
            ) {
                Bucket.entries.forEach { bucket ->
                    FilterChip(
                        selected = item.bucket == bucket,
                        onClick = { vm.repo.move(item, bucket) },
                        label = { Text(bucket.title) }
                    )
                }
            }

            if (item.bucket == Bucket.WAITING) {
                OutlinedTextField(
                    value = waitingOn,
                    onValueChange = { waitingOn = it },
                    label = { Text("Waiting on") },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 12.dp),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(
                        onDone = { vm.repo.setWaitingOn(item, waitingOn) }
                    )
                )
            }

            Spacer(Modifier.height(16.dp))

            // --- due date ---
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Due", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                Spacer(Modifier.width(12.dp))
                AssistChip(
                    onClick = { showDatePicker = true },
                    label = { Text(item.due?.let { DeckDate.label(it) } ?: "Set a date") }
                )
                if (item.due != null) {
                    TextButton(onClick = { vm.repo.setDue(item, null) }) { Text("Clear") }
                }
            }

            Spacer(Modifier.height(16.dp))

            // --- category ---
            Text("Category", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.padding(top = 8.dp)
            ) {
                categories.forEach { category ->
                    FilterChip(
                        selected = item.catId == category.id,
                        onClick = {
                            vm.repo.setCategory(
                                item,
                                if (item.catId == category.id) "" else category.id
                            )
                        },
                        label = { Text(category.name) }
                    )
                }
                if (categories.isEmpty()) {
                    Text(
                        "No categories yet — add some from the ⋮ menu.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.outline
                    )
                }
            }

            Spacer(Modifier.height(16.dp))
            HorizontalDivider()
            Spacer(Modifier.height(16.dp))

            // --- sub-tasks ---
            Text(
                "Sub-tasks ${item.doneSubCount}/${item.subs.size}",
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.Bold
            )

            item.subs.forEach { sub ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(vertical = 4.dp)
                ) {
                    IconButton(
                        onClick = { vm.repo.toggleSubtask(item, sub) },
                        modifier = Modifier.size(28.dp)
                    ) {
                        Icon(
                            if (sub.done) Icons.Default.CheckCircle
                            else Icons.Default.RadioButtonUnchecked,
                            contentDescription = null,
                            tint = if (sub.done) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.outline
                        )
                    }
                    Spacer(Modifier.width(8.dp))
                    Text(
                        sub.text,
                        modifier = Modifier.weight(1f),
                        textDecoration = if (sub.done) TextDecoration.LineThrough else null,
                        color = if (sub.done) MaterialTheme.colorScheme.outline
                        else MaterialTheme.colorScheme.onSurface
                    )
                    IconButton(
                        onClick = { vm.repo.deleteSubtask(item, sub) },
                        modifier = Modifier.size(28.dp)
                    ) {
                        Icon(
                            Icons.Default.Delete,
                            contentDescription = "Delete sub-task",
                            tint = MaterialTheme.colorScheme.outline
                        )
                    }
                }
            }

            OutlinedTextField(
                value = newSub,
                onValueChange = { newSub = it },
                placeholder = { Text("Add a sub-task") },
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = {
                    vm.repo.addSubtask(item, newSub)
                    newSub = ""
                })
            )

            Spacer(Modifier.height(24.dp))

            Button(
                onClick = { vm.repo.delete(item); onDismiss() },
                modifier = Modifier.fillMaxWidth()
            ) {
                Icon(Icons.Default.Delete, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("Delete item")
            }
        }
    }

    if (showDatePicker) {
        val initial = item.due?.atStartOfDay(ZoneOffset.UTC)?.toInstant()?.toEpochMilli()
        val state = rememberDatePickerState(initialSelectedDateMillis = initial)

        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { millis ->
                        // The picker works in UTC millis; convert on the same
                        // basis so the date can't drift by a day.
                        val date: LocalDate = Instant.ofEpochMilli(millis)
                            .atZone(ZoneOffset.UTC)
                            .toLocalDate()
                        vm.repo.setDue(item, date)
                    }
                    showDatePicker = false
                }) { Text("OK") }
            },
            dismissButton = {
                TextButton(onClick = { showDatePicker = false }) { Text("Cancel") }
            }
        ) {
            DatePicker(state = state)
        }
    }
}
