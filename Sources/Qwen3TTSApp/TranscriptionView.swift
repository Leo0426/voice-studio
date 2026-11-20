import AppKit
import AVFoundation
import OpenAISpeech
import SpeechToText
import SwiftUI
import UniformTypeIdentifiers

struct TranscriptionView: View {
    @Bindable var model: TranscriptionModel
    let available: Bool

    private var canStart: Bool { available && (model.provider == .local || model.cloudOptions.validationMessage == nil) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    StudioSectionTitle("音频来源", symbol: "waveform")
                    Spacer()
                    if model.provider == .local {
                        Picker("音频语言", selection: $model.language) {
                            Text("中文").tag("zh")
                            Text("English").tag("en")
                        }
                        .fixedSize().disabled(model.phase != .idle)
                    } else {
                        Text("gpt-transcribe").font(.system(.caption, design: .monospaced)).foregroundStyle(Studio.muted)
                    }
                }
                HStack(spacing: 12) {
                    Button {
                        let panel = NSOpenPanel()
                        panel.allowedContentTypes = model.provider == .local ? [.audio] :
                            OpenAISpeechClient.supportedAudioExtensions.compactMap { UTType(filenameExtension: $0) }
                        panel.prompt = "转写"
                        if panel.runModal() == .OK, let url = panel.url { model.transcribe(file: url) }
                    } label: {
                        Label("选择音频文件…", systemImage: "folder")
                    }
                    .buttonStyle(StudioPrimaryButton())
                    .disabled(model.phase != .idle || !canStart)
                    if model.phase == .recording {
                        Button { model.finishRecording() } label: {
                            Label("结束并转写", systemImage: "stop.circle.fill")
                        }
                        .buttonStyle(StudioPrimaryButton())
                    } else {
                        Button { model.startRecording() } label: { Label("开始录音", systemImage: "mic") }
                            .controlSize(.large).disabled(model.phase != .idle || !canStart)
                    }
                    if model.phase != .idle {
                        Button("取消") { model.cancel() }
                    } else if model.provider == .openAI && !available {
                        OpenAIKeyButton()
                    }
                }
                HStack(spacing: 8) {
                    if model.phase == .requestingMicrophone || model.phase == .transcribing {
                        ProgressView().controlSize(.small)
                    } else if model.phase == .recording {
                        Image(systemName: "record.circle.fill").foregroundStyle(.red)
                    }
                    Text(model.message)
                        .foregroundStyle(model.hasError ? Color.red : Studio.muted)
                        .textSelection(.enabled)
                }
                .font(.callout)
            }
            .padding(16).frame(maxWidth: .infinity, alignment: .leading).studioPanel()
            if model.provider == .openAI {
                VStack(alignment: .leading, spacing: 12) {
                    StudioSectionTitle("转写设置", symbol: "slider.horizontal.3")
                    cloudSettings.disabled(model.phase != .idle)
                }
                .padding(16).studioPanel()
            }
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    StudioSectionTitle("转写结果", symbol: "text.alignleft")
                    if let source = model.resultSource {
                        Text(source).foregroundStyle(Studio.muted).lineLimit(1).truncationMode(.middle)
                    }
                    Spacer()
                    Button { model.copyResult() } label: {
                        Label(model.copied ? "已复制" : "复制文字", systemImage: "doc.on.doc")
                    }
                    .disabled(model.text.isEmpty)
                }
                ScrollView {
                    Text(model.text.isEmpty ? "转写后的文字会显示在这里。" : model.text)
                        .font(.system(size: 15))
                        .foregroundStyle(model.text.isEmpty ? Studio.muted : Studio.text)
                        .lineSpacing(5).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(13)
                }
                .studioPanel(Studio.ink, radius: 7)
            }
            .padding(16).studioPanel()
        }
        .padding(.horizontal, 20).padding(.bottom, 20)
        .frame(minWidth: 670, minHeight: 460)
        .onDisappear { model.cancel() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
            model.cancel()
        }
    }
    private var cloudSettings: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("音频语言")
                TextField("自动识别，可填写多个语言代码", text: $model.cloudLanguages)
                    .accessibilityLabel("音频语言代码")
                Menu("选择语言") {
                    Button("自动识别") { model.cloudLanguages = "" }
                    ForEach([("中文", "zh"), ("英语", "en"), ("中英混合", "zh,en"),
                             ("日语", "ja"), ("韩语", "ko"), ("法语", "fr"),
                             ("西班牙语", "es"), ("德语", "de")], id: \.1) { label, code in
                        Button(label) { model.cloudLanguages = code }
                    }
                }
                .fixedSize()
            }
            LabeledContent("转写背景") {
                TextField("可选，例如，一段关于季度财报的中文访谈", text: $model.cloudPrompt, axis: .vertical)
                    .lineLimit(1...3).accessibilityLabel("转写背景")
            }
            LabeledContent("关键词") {
                TextField("可选，人名、品牌等，用逗号分隔", text: $model.cloudKeywords)
                    .accessibilityLabel("关键词")
            }
            if let message = model.cloudOptions.validationMessage {
                Text(message).font(.callout).foregroundStyle(.red)
            }
        }
        .textFieldStyle(.roundedBorder)
    }

}

@MainActor
@Observable
final class TranscriptionModel: NSObject, AVAudioRecorderDelegate {
    enum Phase { case idle, requestingMicrophone, recording, transcribing }

    private(set) var phase: Phase = .idle
    private(set) var message = "选择一段音频，或使用麦克风录音。"
    private(set) var text = ""
    private(set) var resultSource: String?
    private(set) var hasError = false
    private(set) var copied = false
    private(set) var provider = SpeechProvider.local
    var language = "zh"
    var cloudLanguages = ""
    var cloudKeywords = ""
    var cloudPrompt = ""

    var cloudOptions: OpenAITranscriptionOptions {
        func list(_ text: String) -> [String] {
            text.components(separatedBy: CharacterSet(charactersIn: ",，、\r\n"))
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
        }
        return OpenAITranscriptionOptions(languages: list(cloudLanguages.lowercased()), prompt: cloudPrompt,
                                          keywords: list(cloudKeywords))
    }

    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var recorder: AVAudioRecorder?

    func useProvider(_ newProvider: SpeechProvider) {
        guard newProvider != provider else { return }
        cancel()
        provider = newProvider
        hasError = false
        message = "选择一段音频，或使用麦克风录音。"
    }

    func transcribe(file url: URL) {
        guard phase == .idle else { return }
        recognize(url: url, source: url.lastPathComponent, removeWhenFinished: false)
    }

    func startRecording() {
        guard phase == .idle else { return }
        guard Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") != nil else {
            fail("请打开打包后的 Voice Studio.app 以使用麦克风。")
            return
        }
        phase = .requestingMicrophone
        hasError = false
        message = "正在请求麦克风权限…"
        task = Task {
            guard !Task.isCancelled else { return }
            let allowed = await AVCaptureDevice.requestAccess(for: .audio)
            guard !Task.isCancelled else { return }
            task = nil
            guard allowed else {
                fail("请在「系统设置 → 隐私与安全性 → 麦克风」中允许 Voice Studio 使用麦克风。")
                return
            }
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString).appendingPathExtension("wav")
            do {
                let recording = try AVAudioRecorder(url: url, settings: [
                    AVFormatIDKey: kAudioFormatLinearPCM,
                    AVSampleRateKey: 16_000,
                    AVNumberOfChannelsKey: 1,
                    AVLinearPCMBitDepthKey: 16,
                    AVLinearPCMIsFloatKey: false,
                    AVLinearPCMIsBigEndianKey: false
                ])
                recording.delegate = self
                // 单声道 16 kHz / 16-bit PCM，预留 WAV 头部空间。
                let cloudLimit = Double(OpenAISpeechClient.maximumAudioBytes - 65_536) / 32_000
                let started = provider == .openAI ? recording.record(forDuration: cloudLimit) : recording.record()
                guard started else { throw CocoaError(.fileWriteUnknown) }
                recorder = recording
                phase = .recording
                message = provider == .openAI
                    ? "正在录音，结束后发送至 OpenAI 转写。单段约 13 分钟，到时自动结束。"
                    : "正在录音，点击「结束并转写」后生成文字。"
            } catch {
                try? FileManager.default.removeItem(at: url)
                fail("录音启动失败，请检查麦克风是否可用。")
            }
        }
    }

    func finishRecording() {
        guard phase == .recording, let url = stopRecorder() else { return }
        recognize(url: url, source: "麦克风录音", removeWhenFinished: true)
    }

    func cancel() {
        guard phase != .idle else { return }
        task?.cancel()
        task = nil
        if let url = stopRecorder() { try? FileManager.default.removeItem(at: url) }
        phase = .idle
        hasError = false
        message = "已取消。"
    }

    func copyResult() {
        NSPasteboard.general.clearContents()
        copied = NSPasteboard.general.setString(text, forType: .string)
    }

    private func stopRecorder() -> URL? {
        guard let current = recorder else { return nil }
        current.delegate = nil
        current.stop()
        recorder = nil
        return current.url
    }

    private func recognize(url: URL, source: String, removeWhenFinished: Bool) {
        phase = .transcribing
        hasError = false
        let provider = self.provider
        let language = self.language
        let cloudOptions = self.cloudOptions
        if provider == .local && !LocalTranscriber.isModelInstalled {
            message = "首次转写正在下载识别模型，请保持联网…"
        } else {
            message = "正在转写「" + source + "」…"
        }
        task = Task {
            let scoped = url.startAccessingSecurityScopedResource()
            defer {
                if scoped { url.stopAccessingSecurityScopedResource() }
                if removeWhenFinished { try? FileManager.default.removeItem(at: url) }
            }
            do {
                try Task.checkCancellation()
                let result: String
                switch provider {
                case .local:
                    result = try await LocalTranscriber.transcribe(fileURL: url, language: language)
                case .openAI:
                    result = try await OpenAISpeechClient().transcribe(fileURL: url, options: cloudOptions)
                }
                try Task.checkCancellation()
                text = result
                resultSource = source
                copied = false
                message = result.isEmpty ? "这段音频中没有识别到语音。" : "转写完成。"
                phase = .idle
            } catch {
                guard !Task.isCancelled else { return }
                fail(error.localizedDescription)
            }
            task = nil
        }
    }

    private func fail(_ description: String) {
        phase = .idle
        hasError = true
        message = description
    }

    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor in
            guard self.recorder === recorder else { return }
            if flag { finishRecording() } else { recordingFailed() }
        }
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        Task { @MainActor in
            if self.recorder === recorder { recordingFailed() }
        }
    }

    private func recordingFailed() {
        if let url = stopRecorder() { try? FileManager.default.removeItem(at: url) }
        fail("录音意外中断，请检查麦克风后重试。")
    }
}
