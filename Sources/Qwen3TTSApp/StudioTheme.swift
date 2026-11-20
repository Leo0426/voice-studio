import SwiftUI

enum Studio {
    static let ink = Color(red: 0x10/255, green: 0x13/255, blue: 0x15/255)
    static let panel = Color(red: 0x19/255, green: 0x1d/255, blue: 0x20/255)
    static let raised = Color(red: 0x20/255, green: 0x25/255, blue: 0x28/255)
    static let text = Color(red: 0xf1/255, green: 0xee/255, blue: 0xe7/255)
    static let muted = Color(red: 0xb3/255, green: 0xb7/255, blue: 0xb8/255)
    static let line = Color(red: 0x39/255, green: 0x3f/255, blue: 0x42/255)
    static let gold = Color(red: 0xfa/255, green: 0xc4/255, blue: 0x7a/255)
}

extension View {
    func studioWindow() -> some View {
        self.foregroundStyle(Studio.text)
            .tint(Studio.gold)
            .accentColor(Studio.gold)
            .background(Studio.ink)
            .preferredColorScheme(.dark)
    }

    func studioPanel(_ fill: Color = Studio.panel, radius: CGFloat = 12) -> some View {
        self.background(fill, in: RoundedRectangle(cornerRadius: radius))
            .overlay { RoundedRectangle(cornerRadius: radius).strokeBorder(Studio.line, lineWidth: 1).allowsHitTesting(false) }
    }
}

struct StudioPrimaryButton: ButtonStyle {
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .semibold))
            .padding(.horizontal, 15)
            .frame(minHeight: 34)
            .foregroundStyle(enabled ? Studio.ink : Studio.muted)
            .background(enabled ? Studio.gold.opacity(configuration.isPressed ? 0.78 : 1) : Studio.raised,
                        in: RoundedRectangle(cornerRadius: 7))
            .overlay { RoundedRectangle(cornerRadius: 7).strokeBorder(enabled ? .clear : Studio.line).allowsHitTesting(false) }
    }
}

struct StudioSectionTitle: View {
    let title: String
    let symbol: String

    init(_ title: String, symbol: String) {
        self.title = title
        self.symbol = symbol
    }

    var body: some View {
        Label {
            Text(title).font(.system(size: 15, weight: .semibold))
        } icon: {
            Image(systemName: symbol).foregroundStyle(Studio.gold)
        }
        .labelStyle(.titleAndIcon)
        .accessibilityAddTraits(.isHeader)
    }
}
