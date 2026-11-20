import AppKit
import OpenAISpeech
import SwiftUI

@MainActor @Observable
final class OpenAIKeySettings {
    private let configuration = OpenAIKeyConfiguration()
    private(set) var source: OpenAIKeyConfiguration.Source = .unconfigured

    init() { refresh() }

    func refresh() { source = configuration.source }

    func save(_ key: String) throws {
        try configuration.save(key)
        refresh()
    }
}

struct OpenAIKeyButton: View {
    static let windowID = "openai-api-key"
    static let title = "配置 OpenAI API 密钥…"
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button {
            openWindow(id: Self.windowID)
            NSApp.activate(ignoringOtherApps: true)
        } label: {
            Label(Self.title, systemImage: "key")
        }
        .help("输入或更换 OpenAI 文字转语音、语音转文字共用的 API 密钥")
    }
}

struct OpenAIKeyControl: View {
    let settings: OpenAIKeySettings

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 5) {
                Circle().fill(settings.source == .unconfigured ? Studio.muted : Studio.gold).frame(width: 6, height: 6)
                Text(settings.source == .unconfigured ? "未配置" : "已配置")
                    .font(.caption).foregroundStyle(Studio.muted)
            }
            OpenAIKeyButton()
        }
        .onAppear { settings.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            settings.refresh()
        }
    }
}

struct OpenAIKeyEditor: View {
    let settings: OpenAIKeySettings
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @State private var errorMessage: String?
    @FocusState private var fieldFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                StudioSectionTitle("OpenAI API 密钥", symbol: "key")
                Spacer()
                Text(settings.source == .unconfigured ? "未配置" : "已配置").font(.caption).foregroundStyle(Studio.muted)
            }
            if settings.source == .environment {
                Text("当前使用 OPENAI_API_KEY 环境变量。要更换密钥，请更新环境变量并重新启动应用。")
            } else {
                Text("密钥保存在本机，供 Voice Studio 客户端和本机网页服务使用。")
                SecureField(settings.source == .sharedFile ? "输入新密钥以替换现有密钥" : "输入 OpenAI API 密钥", text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .focused($fieldFocused)
                    .onChange(of: draft) { errorMessage = nil }
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(.red).font(.callout)
                }
            }
            HStack {
                Spacer()
                Button(settings.source == .environment ? "完成" : "取消") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                if settings.source != .environment {
                    Button("保存密钥") { save() }
                        .buttonStyle(StudioPrimaryButton())
                        .keyboardShortcut(.defaultAction)
                        .disabled(draft.isEmpty)
                }
            }
        }
        .padding(24)
        .frame(width: 430)
        .onAppear {
            settings.refresh()
            fieldFocused = settings.source != .environment
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in settings.refresh() }
        .onDisappear { draft = "" }
    }

    private func save() {
        do {
            try settings.save(draft)
            draft = ""
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
