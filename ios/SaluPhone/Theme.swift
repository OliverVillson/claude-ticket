import SwiftUI
import UIKit

/// The salu palette (src/ui/theme.ts): matrix green on black. Roles, not colours. Bright green
/// marks focus and running work, dim green is chrome, amber warns, red errors, teal means paused.
enum Salu {
    static let accent = Color(hex: 0x00FF41)
    static let text = Color(hex: 0x8FFFAA)
    static let ok = Color(hex: 0x00C853)
    static let chrome = Color(hex: 0x1E8F3C)
    static let warn = Color(hex: 0xFFB000)
    static let error = Color(hex: 0xFF5555)
    static let paused = Color(hex: 0x40E0D0)

    /// near-black with a green cast, then two raised surfaces
    static let bg = Color(hex: 0x070B08)
    static let surface = Color(hex: 0x0D1510)
    static let raised = Color(hex: 0x142019)
    static let stroke = Color(hex: 0x1E8F3C).opacity(0.45)
    static let dim = Color(hex: 0x8FFFAA).opacity(0.62)

    static func mono(_ style: Font.TextStyle, weight: Font.Weight = .regular) -> Font {
        .system(style, design: .monospaced, weight: weight)
    }

    /// Navigation and tab bars in the same colours and monospace as the rest.
    @MainActor static func styleBars() {
        let bg = UIColor(Salu.bg)
        let nav = UINavigationBarAppearance()
        nav.configureWithOpaqueBackground()
        nav.backgroundColor = bg
        nav.shadowColor = UIColor(Salu.stroke)
        nav.titleTextAttributes = [.font: UIFont.monospacedSystemFont(ofSize: 17, weight: .semibold), .foregroundColor: UIColor(Salu.text)]
        nav.largeTitleTextAttributes = [.font: UIFont.monospacedSystemFont(ofSize: 32, weight: .bold), .foregroundColor: UIColor(Salu.accent)]
        UINavigationBar.appearance().standardAppearance = nav
        UINavigationBar.appearance().scrollEdgeAppearance = nav
        UINavigationBar.appearance().compactAppearance = nav

        let tab = UITabBarAppearance()
        tab.configureWithOpaqueBackground()
        tab.backgroundColor = bg
        tab.shadowColor = UIColor(Salu.stroke)
        let font = UIFont.monospacedSystemFont(ofSize: 10, weight: .medium)
        for item in [tab.stackedLayoutAppearance, tab.inlineLayoutAppearance, tab.compactInlineLayoutAppearance] {
            item.normal.iconColor = UIColor(Salu.chrome)
            item.normal.titleTextAttributes = [.font: font, .foregroundColor: UIColor(Salu.chrome)]
            item.selected.iconColor = UIColor(Salu.accent)
            item.selected.titleTextAttributes = [.font: font, .foregroundColor: UIColor(Salu.accent)]
            item.normal.badgeBackgroundColor = UIColor(Salu.accent)
            item.normal.badgeTextAttributes = [.foregroundColor: UIColor.black]
        }
        UITabBar.appearance().standardAppearance = tab
        UITabBar.appearance().scrollEdgeAppearance = tab
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

/// Glyph, colour and word for something, the same ones the TUI uses (src/ui/glyphs.ts).
struct Look {
    let glyph: String
    let color: Color
    let label: String
}

extension TicketState {
    var look: Look {
        switch self {
        case .sent: return Look(glyph: "▸", color: Salu.dim, label: "sent")
        case .queued: return Look(glyph: "○", color: Salu.dim, label: "queued")
        case .backlog: return Look(glyph: "◌", color: Salu.dim, label: "backlog")
        case .running: return Look(glyph: "●", color: Salu.accent, label: "working")
        case .blocked: return Look(glyph: "?", color: Salu.warn, label: "blocked")
        case .failed: return Look(glyph: "✗", color: Salu.error, label: "failed")
        case .resolved: return Look(glyph: "✓", color: Salu.ok, label: "resolved")
        }
    }
}

extension SaluMessage {
    var look: Look {
        switch type {
        case "ticket.accepted": return Look(glyph: "○", color: Salu.dim, label: "queued")
        case "ticket.started": return Look(glyph: "●", color: Salu.accent, label: "started")
        case "ticket.done", "ticket.resolved": return Look(glyph: "✓", color: Salu.ok, label: "resolved")
        case "ticket.reopened": return Look(glyph: "○", color: Salu.dim, label: "reopened")
        case "ticket.blocked": return Look(glyph: "?", color: Salu.warn, label: "needs you")
        case "ticket.failed": return Look(glyph: "✗", color: Salu.error, label: "failed")
        case "orchestrator.paused": return Look(glyph: "‖", color: Salu.paused, label: "paused")
        case "orchestrator.resumed": return Look(glyph: "▸", color: Salu.accent, label: "resumed")
        default:
            switch level {
            case "success": return Look(glyph: "✓", color: Salu.ok, label: "note")
            case "warn": return Look(glyph: "!", color: Salu.warn, label: "note")
            case "error": return Look(glyph: "✗", color: Salu.error, label: "note")
            default: return Look(glyph: "·", color: Salu.text, label: "note")
            }
        }
    }

    /// Worth a look from you: blocked tickets, failures, warnings.
    var needsYou: Bool { type == "ticket.blocked" || type == "ticket.failed" || level == "warn" || level == "error" }
}

/// Priority colours from the TUI: 1 loud, 2 amber, 3 plain, 4 and 5 fade out.
func priorityColor(_ p: Int) -> Color {
    switch p {
    case ...1: return Salu.accent
    case 2: return Salu.warn
    case 3: return Salu.text
    default: return Salu.chrome
    }
}
