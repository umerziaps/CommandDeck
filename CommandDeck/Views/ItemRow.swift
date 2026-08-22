import SwiftUI

/// One card on the board. Display only — the surrounding list owns the
/// swipe actions, and the row's category is passed in rather than looked
/// up here so the row stays a pure function of its inputs.
struct ItemRow: View {

    let item: Item
    let category: ItemCategory?
    let index: Int
    let onToggleDone: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            Text("\(index)")
                .font(.deckMono(11, weight: .bold))
                .foregroundStyle(DeckTheme.inkTertiary)
                .frame(width: 16, alignment: .trailing)
                .padding(.top, 3)

            checkbox

            NavigationLink(value: item.id) {
                content
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .background(alignment: .leading) { accentEdge }
        .background(DeckTheme.card)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(
                    isUrgent ? DeckTheme.signal : DeckTheme.hairline,
                    lineWidth: isUrgent ? 1.5 : 1
                )
        }
    }

    private var isUrgent: Bool { item.urgent && !item.done }

    // MARK: - Pieces

    private var accentEdge: some View {
        Rectangle()
            .fill(isUrgent ? DeckTheme.signal : item.bucket.tint)
            .frame(width: 3)
    }

    private var checkbox: some View {
        Button(action: onToggleDone) {
            Image(systemName: item.done ? "checkmark.square.fill" : "square")
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(item.done ? DeckTheme.accent : DeckTheme.inkTertiary)
                .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(.plain)
        .padding(.top, 1)
        .accessibilityLabel(item.done ? "Mark not done" : "Mark done")
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(item.title)
                .font(.system(size: 15))
                .foregroundStyle(item.done ? DeckTheme.inkTertiary : DeckTheme.ink)
                .strikethrough(item.done, color: DeckTheme.inkTertiary)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)

            if !metaIsEmpty {
                HStack(spacing: 10) {
                    if isUrgent { urgentChip }
                    if let category { categoryChip(category) }
                    if item.bucket == .waiting, !item.waitingOn.isEmpty { waitingChip }
                    if item.due != nil { dueChip }
                    if !item.subs.isEmpty { subtaskChip }
                }
                .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var metaIsEmpty: Bool {
        category == nil
            && item.due == nil
            && item.subs.isEmpty
            && !(item.bucket == .waiting && !item.waitingOn.isEmpty)
            && !isUrgent
    }

    private var urgentChip: some View {
        HStack(spacing: 4) {
            Circle().fill(DeckTheme.signal).frame(width: 6, height: 6)
            Text("Urgent")
        }
        .font(.deckMono(11, weight: .bold))
        .foregroundStyle(DeckTheme.signal)
    }

    private func categoryChip(_ category: ItemCategory) -> some View {
        HStack(spacing: 5) {
            Circle().fill(category.color).frame(width: 7, height: 7)
            Text(category.name)
        }
        .font(.deckMono(11, weight: .semibold))
        .foregroundStyle(category.color)
    }

    private var waitingChip: some View {
        Text("waiting on \(item.waitingOn)")
            .font(.deckMono(11))
            .foregroundStyle(DeckTheme.waiting)
    }

    private var dueChip: some View {
        HStack(spacing: 4) {
            Image(systemName: "calendar")
            Text(DeckDate.label(for: item.due ?? .now))
        }
        .font(.deckMono(11))
        .foregroundStyle(dueTint)
    }

    private var dueTint: Color {
        if item.done { return DeckTheme.inkTertiary }
        if item.isOverdue { return DeckTheme.signal }
        if item.isDueSoon { return DeckTheme.waiting }
        return DeckTheme.inkTertiary
    }

    private var subtaskChip: some View {
        HStack(spacing: 4) {
            Image(systemName: "checklist")
            Text("\(item.doneSubCount)/\(item.subs.count)")
        }
        .font(.deckMono(11))
        .foregroundStyle(DeckTheme.inkSecondary)
    }
}
