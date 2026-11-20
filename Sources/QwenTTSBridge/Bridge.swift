import Foundation
import SpeechToText
import TTSCore
import TTSEngineMLX

/// 网页与原生客户端共用本机模型、预置音色及推理实现。
@main
enum QwenTTSBridge {
    private struct Request: Decodable {
        let text: String
        let voice: String
    }

    private struct Preset: Encodable {
        let id: String
        let name: String
    }

    private struct Status: Encodable {
        let available: Bool
        let message: String
        let voices: [Preset]
    }

    private struct TranscriptionStatus: Encodable {
        let available = true
        let modelInstalled: Bool
        let message: String

        init() {
            modelInstalled = LocalTranscriber.isModelInstalled
            message = modelInstalled ? "本地识别模型已就绪。" : "首次转写会下载约 295 MB 的识别模型。"
        }
    }

    @MainActor
    static func main() async {
        let arguments = Array(CommandLine.arguments.dropFirst())
        do {
            if arguments == ["transcription-status"] {
                FileHandle.standardOutput.write(try JSONEncoder().encode(TranscriptionStatus()))
                return
            }
            if (3...4).contains(arguments.count), arguments[0] == "transcribe" {
                let text = try await LocalTranscriber.transcribe(
                    fileURL: URL(fileURLWithPath: arguments[1]),
                    language: arguments.count == 4 ? arguments[3] : "zh"
                )
                try text.write(to: URL(fileURLWithPath: arguments[2]), atomically: true, encoding: .utf8)
                return
            }
            let appID = "dev.leolu.qwen3-tts"
            let defaults = Bundle.main.bundleIdentifier == appID
                ? UserDefaults.standard : (UserDefaults(suiteName: appID) ?? .standard)
            let repo = defaults.string(forKey: "modelRepo") ?? MLXInferenceEngine.defaultModelRepo
            let path = defaults.string(forKey: "modelStoragePath") ?? ""
            let directory = path.isEmpty ? nil : URL(fileURLWithPath: path, isDirectory: true)
            let manager = MLXModelManager(modelRepo: repo, cacheDirectory: directory)
            if arguments == ["status"] {
                let ready = manager.isInstalled
                let status = Status(
                    available: ready,
                    message: ready ? "本地模型已就绪" : "请先在 macOS 客户端的模型下载中心安装预置音色模型。",
                    voices: Voice.presets.map { Preset(id: $0.id, name: "\($0.displayName) · \($0.detail)") }
                )
                FileHandle.standardOutput.write(try JSONEncoder().encode(status))
                return
            }
            guard arguments.count == 2, arguments[0] == "synthesize" else {
                throw InferenceError.generationFailed("用法：status、synthesize <输出 WAV>、transcription-status 或 transcribe <输入音频> <输出文本> [zh|en]")
            }
            guard manager.isInstalled else { throw InferenceError.modelNotReady }
            let data = FileHandle.standardInput.readDataToEndOfFile()
            let request = try JSONDecoder().decode(Request.self, from: data)
            let text = request.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, text.unicodeScalars.count <= 800,
                  let voice = Voice.presets.first(where: { $0.id == request.voice }) else {
                throw InferenceError.generationFailed("请选择预置音色，输入 1 至 800 个字符。")
            }
            let engine = SegmentingEngine(base: MLXInferenceEngine(modelRepo: repo, cacheDirectory: directory))
            var samples: [Float] = []
            var sampleRate = 24_000.0
            for try await chunk in engine.synthesize(text: text, voice: voice) {
                samples += chunk.samples
                sampleRate = chunk.sampleRate
            }
            guard !samples.isEmpty else { throw InferenceError.generationFailed("模型没有生成音频。") }
            try WavFile.write(samples: samples, sampleRate: sampleRate, to: URL(fileURLWithPath: arguments[1]))
        } catch {
            let prefix = arguments.first == "transcribe" ? "转写失败：" : ""
            FileHandle.standardError.write(Data((prefix + error.localizedDescription + "\n").utf8))
            exit(1)
        }
    }
}
