import AVFoundation
import OpenAISpeech
import SwiftUI
import UniformTypeIdentifiers

struct OpenAISynthesisView: View {
    @Binding var text: String
    let configured: Bool
    @Bindable var output: OpenAISynthesisOutput
    @State private var enrollingVoice = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            StudioSectionTitle("朗读文本", symbol: "text.alignleft")
                            Spacer()
                            Text("\(text.unicodeScalars.count) / \(output.settings.model.maximumTextLength)")
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(text.unicodeScalars.count > output.settings.model.maximumTextLength ? Color.red : Studio.muted)
                        }
                        TextEditor(text: $text)
                            .font(.system(size: 16))
                            .lineSpacing(6).scrollContentBackground(.hidden)
                            .padding(8)
                            .frame(minHeight: 126)
                            .accessibilityLabel("合成文本")
                            .studioPanel(Studio.ink, radius: 7)
                    }
                    .padding(16).studioPanel()
                    VStack(alignment: .leading, spacing: 14) {
                        StudioSectionTitle("声音设置", symbol: "slider.horizontal.3")
                        synthSettings.disabled(output.generating)
                    }
                    .padding(16).studioPanel()
                }
                .padding(2)
            }
            if let message = output.options.validationMessage ?? output.error {
                Text(message).font(.callout).foregroundStyle(.red).textSelection(.enabled)
            }
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    StudioSectionTitle("音频试听", symbol: "waveform")
                    if let label = output.resultLabel {
                        Text(label).foregroundStyle(Studio.muted).lineLimit(1).truncationMode(.tail)
                    }
                    Spacer()
                    if output.generating {
                        ProgressView().controlSize(.small)
                        Button("取消生成") { output.cancel() }
                    } else if !configured {
                        OpenAIKeyButton().buttonStyle(StudioPrimaryButton())
                    } else {
                        Button("生成语音") { output.generate(text: text) }
                            .buttonStyle(StudioPrimaryButton())
                            .keyboardShortcut(.return, modifiers: .command)
                            .disabled(output.options.validationMessage != nil ||
                                      text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                                      text.unicodeScalars.count > output.settings.model.maximumTextLength)
                    }
                }
                if let format = output.resultFormat, output.duration > 0 {
                    TimelineView(.periodic(from: .now, by: 0.2)) { _ in
                        HStack(spacing: 10) {
                            Button { output.togglePlayback() } label: {
                                Label(output.playing ? "暂停" : "试听", systemImage: output.playing ? "pause.fill" : "play.fill")
                            }
                            .disabled(output.generating)
                            Slider(value: Binding(get: { output.position }, set: { output.seek(to: $0) }),
                                   in: 0...output.duration)
                                .accessibilityLabel("播放位置")
                            Text(Duration.seconds(output.position).formatted(.time(pattern: .minuteSecond(padMinuteToLength: 1))))
                                .font(.system(.caption, design: .monospaced)).foregroundStyle(Studio.muted)
                            Button("导出 \(format.rawValue.uppercased())…") { output.export() }
                        }
                    }
                }
            }
            .padding(14).studioPanel()
        }
        .padding(.horizontal, 20).padding(.bottom, 20)
        .frame(minWidth: 670, minHeight: 460)
        .sheet(isPresented: $enrollingVoice) {
            VoiceEnrollmentView(enrollment: output.enrollment, configured: configured) { id in
                output.customVoiceID = id
                output.settings.voice = "custom"
            }
        }
        .onDisappear { output.cancel() }
    }

    private var synthSettings: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 16) {
                Picker("模型", selection: $output.settings.model) {
                    ForEach(OpenAISynthesisModel.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                Picker("格式", selection: $output.settings.format) {
                    ForEach(OpenAIAudioFormat.allCases, id: \.self) { Text($0.rawValue.uppercased()).tag($0) }
                }
                .fixedSize()
            }
            HStack(alignment: .firstTextBaseline) {
                Picker("音色", selection: $output.settings.voice) {
                    ForEach(OpenAISpeechClient.voices, id: \.self) { Text($0.capitalized).tag($0) }
                    Divider()
                    Text("自定义音色").tag("custom")
                }
                .fixedSize()
                if output.settings.voice == "custom" {
                    TextField("已获授权的声音 ID，例如 voice_1234", text: $output.customVoiceID)
                        .accessibilityLabel("自定义声音 ID")
                }
                Button("创建自定义音色…") { enrollingVoice = true }
            }
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 10) {
                GridRow {
                    deliveryField("风格", text: $output.settings.style, examples: ["自然", "新闻播报", "故事讲述", "对话", "纪录片"])
                    deliveryField("情感", text: $output.settings.emotion, examples: ["平静", "愉快", "温暖", "严肃", "兴奋"])
                }
                GridRow {
                    if output.settings.model == .speech {
                        HStack {
                            Text("语速")
                            Slider(value: $output.settings.speed, in: 0.25...4, step: 0.05)
                                .accessibilityLabel("朗读倍速")
                            Text("\(output.settings.speed, specifier: "%.2f")×").monospacedDigit()
                        }
                    } else {
                        deliveryField("语速", text: $output.settings.pace, examples: ["舒缓", "适中", "明快"])
                    }
                    deliveryField("口音", text: $output.settings.accent, examples: ["标准普通话", "美式英语", "英式英语", "粤语"])
                }
            }
            LabeledContent("补充指导") {
                TextField("例如，音高偏低、音色柔和，段落间稍作停顿", text: $output.settings.instructions, axis: .vertical)
                    .lineLimit(1...3).accessibilityLabel("补充指导")
            }
        }
        .textFieldStyle(.roundedBorder)
    }

    private func deliveryField(_ label: String, text: Binding<String>, examples: [String]) -> some View {
        HStack(spacing: 6) {
            Text(label)
            TextField("随模型", text: text).accessibilityLabel(label)
            Menu {
                Button("随模型") { text.wrappedValue = "" }
                ForEach(examples, id: \.self) { item in Button(item) { text.wrappedValue = item } }
            } label: {
                Image(systemName: "chevron.down.circle")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .accessibilityLabel("选择" + label)
        }
    }
}

@MainActor
@Observable
final class OpenAISynthesisOutput: NSObject, AVAudioPlayerDelegate {
    let enrollment = VoiceEnrollment()
    var settings = OpenAISynthesisOptions()
    var customVoiceID = ""
    var options: OpenAISynthesisOptions {
        var options = settings
        options.customVoiceID = settings.voice == "custom" ? customVoiceID : nil
        return options
    }
    private(set) var resultFormat: OpenAIAudioFormat?
    private(set) var generating = false
    private(set) var playing = false
    private(set) var error: String?
    private(set) var resultLabel: String?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var player: AVAudioPlayer?
    @ObservationIgnored private var audio: Data?

    func generate(text: String) {
        guard !generating else { return }
        player?.pause()
        playing = false
        error = nil
        generating = true
        let options = self.options
        task = Task {
            do {
                try Task.checkCancellation()
                let data = try await OpenAISpeechClient().synthesize(text: text, options: options)
                try Task.checkCancellation()
                let playback = try AVAudioPlayer(data: data)
                playback.delegate = self
                player = playback
                audio = data
                resultFormat = options.format
                let voice = options.customVoiceID == nil ? options.voice.capitalized : "自定义音色"
                resultLabel = "\(voice) · \(playback.duration.formatted(.number.precision(.fractionLength(1)))) 秒 · \(text.prefix(24))"
            } catch {
                guard !Task.isCancelled else { return }
                self.error = error.localizedDescription
            }
            generating = false
            task = nil
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
        generating = false
        player?.pause()
        playing = false
    }

    var duration: TimeInterval { player?.duration ?? 0 }
    var position: TimeInterval { player?.currentTime ?? 0 }

    func seek(to seconds: TimeInterval) {
        player?.currentTime = min(max(0, seconds), duration)
    }

    func togglePlayback() {
        guard let player else { return }
        if playing {
            player.pause()
            playing = false
        } else {
            playing = player.play()
            if !playing { error = "无法播放音频，请检查声音输出设备。" }
        }
    }

    func export() {
        guard let audio, let ext = resultFormat?.rawValue, let type = UTType(filenameExtension: ext) else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [type]
        panel.nameFieldStringValue = "OpenAI-语音.\(ext)"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try audio.write(to: url, options: .atomic) }
        catch { self.error = error.localizedDescription }
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            guard self.player === player else { return }
            playing = false
            player.currentTime = 0
            if !flag { error = "播放被中断，请重试。" }
        }
    }
}
