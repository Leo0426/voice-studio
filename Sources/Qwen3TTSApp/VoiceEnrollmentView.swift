import AppKit
import OpenAISpeech
import SwiftUI
import UniformTypeIdentifiers

@MainActor @Observable
final class VoiceEnrollment {
    enum ConsentSource: String { case recording, existing }
    enum Step { case uploadConsent, createVoice }

    var name = ""
    var language = "zh"
    var consentSource: ConsentSource = .recording
    var existingConsent = ""
    var recording: URL?
    var sample: URL?
    private(set) var uploadedConsent: String?
    private(set) var voiceID: String?
    private(set) var working: Step?
    private(set) var status = ""
    private(set) var hasError = false

    var consentID: String {
        consentSource == .recording ? uploadedConsent ?? "" : existingConsent.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var validName: Bool { (1...256).contains(name.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.count) }
    var canUpload: Bool { validName && working == nil && recording != nil && uploadedConsent == nil }
    var canCreate: Bool {
        validName && working == nil && voiceID == nil && sample != nil &&
            consentID.range(of: #"\Acons_[A-Za-z0-9_-]{1,200}\z"#, options: .regularExpression) != nil
    }

    func invalidateConsent() {
        uploadedConsent = nil
        clearVoice()
    }

    func clearVoice() {
        voiceID = nil
        status = ""
        hasError = false
    }

    func selectAudio(for step: Step) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = OpenAISpeechClient.enrollmentAudioExtensions.compactMap { UTType(filenameExtension: $0) }
        panel.prompt = "选择"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        switch step {
        case .uploadConsent:
            recording = url
            invalidateConsent()
        case .createVoice:
            sample = url
            clearVoice()
        }
    }

    func submit(_ step: Step) {
        let file: URL
        switch step {
        case .uploadConsent:
            guard canUpload, let recording else { return }
            file = recording
        case .createVoice:
            guard canCreate, let sample else { return }
            file = sample
        }
        working = step
        status = step == .uploadConsent ? "正在上传授权录音…" : "正在创建音色…"
        hasError = false
        let name = self.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let language = self.language
        let consent = consentID
        Task {
            let scoped = file.startAccessingSecurityScopedResource()
            defer {
                if scoped { file.stopAccessingSecurityScopedResource() }
                working = nil
            }
            do {
                switch step {
                case .uploadConsent:
                    uploadedConsent = try await OpenAISpeechClient().uploadVoiceConsent(name: name, language: language, recordingURL: file)
                    status = "已取得授权 ID，可以使用同一说话人的声音样本创建音色。"
                case .createVoice:
                    voiceID = try await OpenAISpeechClient().createVoice(name: name, consentID: consent, sampleURL: file)
                    status = "音色已保存至 OpenAI 项目。"
                }
            } catch {
                hasError = true
                status = error.localizedDescription
            }
        }
    }
}

struct VoiceEnrollmentView: View {
    @Bindable var enrollment: VoiceEnrollment
    let configured: Bool
    let useVoice: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    private var declaration: String {
        enrollment.language == "zh"
            ? "我是此声音的拥有者并授权OpenAI使用此声音创建语音合成模型"
            : "I am the owner of this voice and I consent to OpenAI using this voice to create a synthetic voice model."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("创建自定义音色").font(.title2.bold())
            Text("支持此功能的 OpenAI 项目可使用说话人本人的授权录音和声音样本创建音色。点击上传或创建后，对应文件将发送至 OpenAI。")
                .font(.callout).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 12) {
                LabeledContent("音色名称") {
                    TextField("例如，中文旁白", text: $enrollment.name).accessibilityLabel("音色名称")
                }
                Picker("声音授权", selection: $enrollment.consentSource) {
                    Text("上传授权录音").tag(VoiceEnrollment.ConsentSource.recording)
                    Text("使用已有授权 ID").tag(VoiceEnrollment.ConsentSource.existing)
                }
                .pickerStyle(.segmented)
                if enrollment.consentSource == .recording {
                    Picker("声明语言", selection: $enrollment.language) {
                        Text("中文").tag("zh")
                        Text("English").tag("en")
                    }
                    .fixedSize()
                    Text("请由说话人逐字朗读以下声明。").font(.callout)
                    Text(declaration).textSelection(.enabled).padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 5))
                    HStack {
                        filePicker(.uploadConsent, title: "选择授权录音…", file: enrollment.recording)
                        Spacer()
                        Button("上传授权录音") { enrollment.submit(.uploadConsent) }
                            .disabled(!configured || !enrollment.canUpload)
                    }
                    if let id = enrollment.uploadedConsent {
                        Text("授权 ID  " + id).font(.callout).textSelection(.enabled)
                    }
                } else {
                    LabeledContent("授权 ID") {
                        TextField("cons_…", text: $enrollment.existingConsent).accessibilityLabel("授权 ID")
                    }
                }
                Divider()
                filePicker(.createVoice, title: "选择声音样本…", file: enrollment.sample)
                Text("请用同一说话人朗读完整句子，建议 10–60 秒，并包含至少 5 秒真实语音和 15 个转录 token。每个文件最大 10 MiB。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .textFieldStyle(.roundedBorder)
            .disabled(enrollment.working != nil)
            if !configured {
                OpenAIKeyButton()
            }
            if !enrollment.status.isEmpty {
                HStack {
                    if enrollment.working != nil { ProgressView().controlSize(.small) }
                    Text(enrollment.status).foregroundStyle(enrollment.hasError ? Color.red : Color.secondary)
                        .textSelection(.enabled)
                }.font(.callout)
            }
            if let id = enrollment.voiceID {
                LabeledContent("声音 ID") { Text(id).textSelection(.enabled) }
            }
            HStack {
                Button("关闭") { dismiss() }.disabled(enrollment.working != nil).keyboardShortcut(.cancelAction)
                Spacer()
                if let id = enrollment.voiceID {
                    Button("用于本次朗读") { useVoice(id); dismiss() }.buttonStyle(StudioPrimaryButton())
                } else {
                    Button("创建音色") { enrollment.submit(.createVoice) }
                        .buttonStyle(StudioPrimaryButton())
                        .disabled(!configured || !enrollment.canCreate)
                }
            }
        }
        .padding(22)
        .frame(width: 550)
        .studioWindow()
        .interactiveDismissDisabled(enrollment.working != nil)
        .onChange(of: enrollment.consentSource) { enrollment.clearVoice() }
        .onChange(of: enrollment.language) { enrollment.invalidateConsent() }
        .onChange(of: enrollment.existingConsent) { enrollment.clearVoice() }
        .onChange(of: enrollment.name) { enrollment.clearVoice() }
    }

    private func filePicker(_ step: VoiceEnrollment.Step, title: String, file: URL?) -> some View {
        HStack {
            Button(title) { enrollment.selectAudio(for: step) }
            if let file { Text(file.lastPathComponent).lineLimit(1).truncationMode(.middle) }
        }
    }
}
