import SwiftUI
import UIKit

// MARK: - Hex colors

extension Color {
    /// Parses "#RRGGBB" / "RRGGBB" / "#RRGGBBAA". Returns nil on anything else.
    init?(hex: String) {
        var raw = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.hasPrefix("#") { raw.removeFirst() }
        guard raw.count == 6 || raw.count == 8,
              let value = UInt64(raw, radix: 16) else { return nil }

        let r, g, b, a: Double
        if raw.count == 6 {
            r = Double((value & 0xFF0000) >> 16) / 255
            g = Double((value & 0x00FF00) >> 8) / 255
            b = Double(value & 0x0000FF) / 255
            a = 1
        } else {
            r = Double((value & 0xFF00_0000) >> 24) / 255
            g = Double((value & 0x00FF_0000) >> 16) / 255
            b = Double((value & 0x0000_FF00) >> 8) / 255
            a = Double(value & 0x0000_00FF) / 255
        }
        self.init(.sRGB, red: r, green: g, blue: b, opacity: a)
    }
}

// MARK: - Palette

/// The Command Deck palette, carried over hex-for-hex from the web version.
/// Every colour resolves against the active interface style, so the whole
/// app follows light/dark without a single `if colorScheme ==` in a view.
enum DeckTheme {

    // Surfaces
    static let background = adaptive(light: "#F5F6F8", dark: "#0F1216")
    static let card = adaptive(light: "#FFFFFF", dark: "#161A21")
    static let cardRaised = adaptive(light: "#F0F2F5", dark: "#1E232C")

    // Text
    static let ink = adaptive(light: "#141619", dark: "#EDF0F3")
    static let inkSecondary = adaptive(light: "#525A64", dark: "#9BA3AE")
    static let inkTertiary = adaptive(light: "#8A929C", dark: "#646C78")

    // Semantic
    static let accent = adaptive(light: "#12A886", dark: "#5EE6C5")
    static let now = adaptive(light: "#12A886", dark: "#5EE6C5")
    static let later = adaptive(light: "#5566D8", dark: "#7C89F0")
    static let waiting = adaptive(light: "#B5791A", dark: "#F0B45E")
    static let signal = adaptive(light: "#E5522F", dark: "#FF6B54")

    static let hairline = adaptive(light: "#141619", dark: "#FFFFFF").opacity(0.10)

    /// Colours offered when creating or recolouring a category.
    static let categoryPalette: [String] = [
        "#5EE6C5", "#7C89F0", "#F0B45E", "#FF6B54", "#63C7A6",
        "#C78BF0", "#F07CA8", "#8ECF5E", "#5EB8E6", "#E6C25E"
    ]

    /// Picks the first palette colour not already in use.
    static func nextColor(excluding used: [String]) -> String {
        categoryPalette.first { !used.contains($0) }
            ?? categoryPalette[used.count % categoryPalette.count]
    }

    private static func adaptive(light: String, dark: String) -> Color {
        let lightColor = UIColor(Color(hex: light) ?? .gray)
        let darkColor = UIColor(Color(hex: dark) ?? .gray)
        return Color(UIColor { traits in
            traits.userInterfaceStyle == .dark ? darkColor : lightColor
        })
    }
}

// MARK: - Appearance preference

enum AppearanceMode: String, CaseIterable, Identifiable {
    case system, light, dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    var symbol: String {
        switch self {
        case .system: "circle.lefthalf.filled"
        case .light: "sun.max.fill"
        case .dark: "moon.fill"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

// MARK: - Shared type styles

extension Font {
    /// Rounded display face, standing in for Space Grotesk without shipping a font file.
    static func deckDisplay(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        .system(size: size, weight: weight, design: .rounded)
    }

    static func deckMono(_ size: CGFloat, weight: Font.Weight = .medium) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}
