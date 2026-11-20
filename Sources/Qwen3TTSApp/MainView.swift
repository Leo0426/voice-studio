import SwiftUI
import TTSCore

struct MainView: View {
    @Bindable var model: AppModel
    @State private var showModelInfo = false
    @State private var showCloneSheet = false
    @State private var showDesignSheet = false

    var body: some View {
        editorPane
            .padding(.horizontal, 20)
            .padding(.bottom, 20)
            .frame(minWidth: 670, minHeight: 460)
            .overlay {
            if let manager = model.modelManager {
                ModelSetupOverlay(manager: manager) {
                    model.downloadModel()
                }
            }
        }
        .toolbar {
            if let manager = model.modelManager {
                ToolbarItem {
                    Button {
                        model.deviceAccess.perform { showModelInfo.toggle() }
                    } label: {
                        Label("模型", systemImage: "cpu")
                    }
                    .help("本地模型状态与管理")
                    .popover(isPresented: $showModelInfo, arrowEdge: .bottom) {
                        ModelInfoPopover(manager: manager, access: model.deviceAccess)
                    }
                }
            }
        }
    }

    private var editorPane: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    StudioSectionTitle("朗读文本", symbol: "text.alignleft")
                    Spacer()
                    Text("\(model.text.count) 字")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(Studio.muted)
                }
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $model.text)
                        .font(.system(size: 16))
                        .lineSpacing(7)
                        .scrollContentBackground(.hidden)
                        .padding(9)
                        .accessibilityLabel("朗读文本")
                    if model.text.isEmpty {
                        Text("在这里输入或粘贴要朗读的文字…")
                            .font(.system(size: 15))
                            .foregroundStyle(Studio.muted)
                            .padding(.top, 12).padding(.leading, 15)
                            .allowsHitTesting(false)
                    }
                }
                .frame(maxHeight: .infinity)
                .studioPanel(Studio.ink, radius: 7)
            }
            .padding(16)
            .studioPanel()
            controlBar
            PlaybackBar(model: model)
        }
        .padding(.trailing, 9)
    }

    private var controlBar: some View {
        VStack(alignment: .leading, spacing: 11) {
            StudioSectionTitle("声音设置", symbol: "slider.horizontal.3")
            if model.isDialogue {
                dialogueBindingPanel
            }
            TextField(instructionPlaceholder, text: model.deviceAccess.binding($model.instruction))
                .textFieldStyle(.plain)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .studioPanel(Studio.ink, radius: 6)
                .disabled(model.isSynthesizing || (!model.isDialogue && (model.usingClone || model.usingDesign)))
            HStack(spacing: 12) {
                voicePicker
                cloneButton
                designButton
                Spacer()
                statusText
                synthesizeButton
            }
            if let message = model.historyWarning {
                HStack {
                    Label(message, systemImage: "exclamationmark.triangle")
                    Button("重试保存") { model.retrySavingHistory() }.disabled(model.savingHistory || model.isSynthesizing)
                }.font(.callout)
            }
            if let errorMessage = model.errorMessage {
                HStack(spacing: 8) {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .font(.callout)
                    if model.errorNeedsDownloadCenter {
                        Button("去下载") {
                            model.present(.downloads)
                        }
                        .controlSize(.small)
                    }
                    Spacer()
                    Button {
                        model.clearError()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.borderless)
                    .help("关闭提示")
                }
            }
        }
        .padding(16)
        .studioPanel()
    }

    private var voicePicker: some View {
        Picker(selection: model.deviceAccess.binding($model.voiceSelection)) {
            Section("预置音色") {
                ForEach(Voice.presets) { voice in
                    Text("\(voice.displayName) — \(voice.detail)").tag(VoiceSelection.preset(voice.id))
                }
            }
            if !model.clonedVoices.items.isEmpty {
                Section("克隆音色") {
                    ForEach(model.clonedVoices.items) { voice in
                        Text("\(voice.name) — 克隆").tag(VoiceSelection.clone(voice.id))
                    }
                }
            }
            if !model.designedVoices.items.isEmpty {
                Section("语音设计") {
                    ForEach(model.designedVoices.items) { voice in
                        Text("\(voice.name) — 设计").tag(VoiceSelection.design(voice.id))
                    }
                }
            }
        } label: {
            Label("音色", systemImage: "person.wave.2")
        }
        .pickerStyle(.menu)
        .fixedSize()
        .disabled(model.isSynthesizing)
    }

    private var instructionPlaceholder: String {
        if model.isDialogue { return "风格指令（可选）：作用于对话中全部预置音色角色" }
        if model.usingClone { return "克隆音色的风格由参考音频决定，指令不生效" }
        if model.usingDesign { return "设计音色的风格由声音描述决定，指令不生效" }
        return "风格指令（可选），如：用温柔的语气慢慢说"
    }

    // MARK: - 对话模式

    /// 角色绑定面板：检测到的角色逐个绑定音色；旁白跟随主音色
    private var dialogueBindingPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Label("对话模式 · \(model.dialogueRoles.count) 角色 · \(model.dialogueLines.count) 段", systemImage: "person.2.wave.2")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                if model.dialogueHasNarration {
                    Text("旁白使用主音色")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                Spacer()
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 200), alignment: .leading)], alignment: .leading, spacing: 6) {
                ForEach(model.dialogueRoles, id: \.self) { role in
                    rolePicker(role)
                }
            }
            if let message = model.dialogueValidationMessage {
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
        .padding(10)
        .background(.quinary, in: RoundedRectangle(cornerRadius: 8))
    }

    private func rolePicker(_ role: String) -> some View {
        Picker(selection: Binding(
            get: { model.binding(for: role) },
            set: { if let selection = $0 { model.setBinding(selection, for: role) } }
        )) {
            Text("未绑定").tag(VoiceSelection?.none)
            Section("预置音色") {
                ForEach(Voice.presets) { voice in
                    Text("\(voice.displayName) — \(voice.detail)").tag(VoiceSelection?.some(.preset(voice.id)))
                }
            }
            if !model.clonedVoices.items.isEmpty {
                Section("克隆音色") {
                    ForEach(model.clonedVoices.items) { voice in
                        Text("\(voice.name) — 克隆").tag(VoiceSelection?.some(.clone(voice.id)))
                    }
                }
            }
            if !model.designedVoices.items.isEmpty {
                Section("语音设计") {
                    ForEach(model.designedVoices.items) { voice in
                        Text("\(voice.name) — 设计").tag(VoiceSelection?.some(.design(voice.id)))
                    }
                }
            }
        } label: {
            Text(role)
                .fontWeight(.medium)
        }
        .pickerStyle(.menu)
        .disabled(model.isSynthesizing)
    }

    private var cloneButton: some View {
        Button {
            model.deviceAccess.perform { showCloneSheet = true }
        } label: {
            Image(systemName: "person.badge.plus")
        }
        .help("克隆音色：用一段参考音频复刻声音")
        .disabled(model.isSynthesizing)
        .sheet(isPresented: $showCloneSheet) {
            CloneVoiceSheet(model: model)
        }
    }

    private var designButton: some View {
        Button {
            model.deviceAccess.perform { showDesignSheet = true }
        } label: {
            Image(systemName: "wand.and.stars")
        }
        .help("语音设计：用自然语言描述凭空造声音")
        .disabled(model.isSynthesizing)
        .sheet(isPresented: $showDesignSheet) {
            DesignVoiceSheet(model: model)
        }
    }

    private var statusText: some View {
        Group {
            if model.savingHistory {
                Text("正在保存任务历史…")
            } else if model.isSynthesizing {
                if let latency = model.firstChunkLatency {
                    Text("生成中 · 首包 \(String(format: "%.2f", latency))s")
                } else {
                    Text("准备中…")
                }
            }
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        .monospacedDigit()
    }

    private var synthesizeButton: some View {
        Group {
            if model.isSynthesizing {
                Button(role: .cancel) {
                    model.cancelSynthesis()
                } label: {
                    Label("停止", systemImage: "stop.fill")
                        .frame(minWidth: 64)
                }.disabled(model.savingHistory)
            } else {
                Button {
                    model.synthesize()
                } label: {
                    Label("合成并播放", systemImage: "play.fill")
                        .frame(minWidth: 64)
                }
                .buttonStyle(StudioPrimaryButton())
                .disabled(!model.canSynthesize)
            }
        }
        .keyboardShortcut(.return, modifiers: .command)
        .help("⌘⏎ 合成并播放")
    }
}

/// 播放控制条：进度 + 播放/暂停/重播/导出
struct PlaybackBar: View {
    @Bindable var model: AppModel
    /// 拖动波形时的预览进度；松手才真正 seek
    @State private var scrubFraction: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                StudioSectionTitle("音频试听", symbol: "waveform")
                Spacer()
                Text("WAV").font(.system(.caption, design: .monospaced)).foregroundStyle(Studio.muted)
            }
            TimelineView(.periodic(from: .now, by: 0.25)) { _ in
                HStack(spacing: 12) {
                    playPauseButton
                    Button {
                        model.replay()
                    } label: {
                        Image(systemName: "arrow.counterclockwise")
                    }
                    .help("重播")
                    .disabled(model.player.samples.isEmpty)

                    progressView

                    rateMenu

                    Button {
                        model.exportCurrentAudio()
                    } label: {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .help("导出 WAV")
                    .disabled(!model.hasAudio)
                }
                .buttonStyle(.borderless)
                .controlSize(.large)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .studioPanel()
    }

    private var playPauseButton: some View {
        Button {
            switch model.player.state {
            case .playing: model.player.pause()
            case .paused: model.deviceAccess.perform { model.player.resume() }
            case .finished, .idle: model.replay()
            }
        } label: {
            Image(systemName: model.player.state == .playing ? "pause.fill" : "play.fill")
                .font(.system(size: 13, weight: .bold))
                .frame(width: 32, height: 32)
                .foregroundStyle(model.player.samples.isEmpty ? Studio.muted : Studio.ink)
                .background(model.player.samples.isEmpty ? Studio.raised : Studio.gold, in: Circle())
        }
        .help(model.player.state == .playing ? "暂停" : "播放")
        .disabled(model.player.samples.isEmpty)
    }

    private static let rateOptions: [Float] = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]

    private var rateMenu: some View {
        Menu {
            ForEach(Self.rateOptions, id: \.self) { rate in
                Button {
                    model.deviceAccess.perform { model.playbackRate = rate }
                } label: {
                    if model.playbackRate == rate {
                        Label(Self.formatRate(rate), systemImage: "checkmark")
                    } else {
                        Text(Self.formatRate(rate))
                    }
                }
            }
        } label: {
            Text(Self.formatRate(model.playbackRate))
                .font(.caption)
                .monospacedDigit()
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("播放速度（变速不变调）")
    }

    private static func formatRate(_ rate: Float) -> String {
        rate == rate.rounded() ? String(format: "%.0f×", rate) : String(format: "%.2g×", rate)
    }

    private var progressView: some View {
        let buffered = model.player.bufferedDuration
        let played = min(model.player.playbackTime, buffered)
        let liveFraction = buffered > 0 ? played / buffered : 0
        let shownFraction = scrubFraction ?? liveFraction
        return HStack(spacing: 10) {
            Text(Self.format(scrubFraction.map { $0 * buffered } ?? played))
            GeometryReader { geometry in
                WaveformView(samples: model.player.samples, progress: shownFraction)
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { value in
                                scrubFraction = min(max(0, value.location.x / geometry.size.width), 1)
                            }
                            .onEnded { value in
                                let fraction = min(max(0, value.location.x / geometry.size.width), 1)
                                scrubFraction = nil
                                model.deviceAccess.perform { model.player.seek(to: fraction * model.player.bufferedDuration) }
                            }
                    )
            }
            .frame(height: 26)
            .frame(maxWidth: .infinity)
            .help("点按或拖动跳转")
            Text(Self.format(buffered) + (model.isSynthesizing ? "+" : ""))
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .monospacedDigit()
    }

    private static func format(_ time: TimeInterval) -> String {
        let total = Int(time.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
