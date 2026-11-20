import AVFoundation
import Foundation
import HuggingFace
import MLX
import MLXAudioCore
import MLXAudioSTT

public enum LocalTranscriber {
    private static let repo = Repo.ID(namespace: "openai", name: "whisper-base")
    private static let revision = "e37978b90ca9030d5170a5c07aadb050351a65bb"
    private static let files = ["model.safetensors", "config.json", "generation_config.json",
                                "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"]
    private static let sampleRate = 16_000

    private static var installedDirectory: URL? {
        let cache = HubCache.default
        guard let url = try? cache.snapshotPath(repo: repo, kind: .model, commitHash: revision),
              files.allSatisfy({ FileManager.default.isReadableFile(atPath: url.appendingPathComponent($0).path) })
        else { return nil }
        return url
    }

    public static var isModelInstalled: Bool { installedDirectory != nil }

    private static func loadModel() async throws -> WhisperModel {
        let directory: URL
        if let installedDirectory {
            directory = installedDirectory
        } else {
            do {
                directory = try await HubClient(cache: .default).downloadSnapshot(
                    of: repo, revision: revision, matching: files
                )
            } catch {
                try Task.checkCancellation()
                throw TranscriptionError.download
            }
        }
        try Task.checkCancellation()
        return try await WhisperModel.fromDirectory(directory)
    }

    public static func transcribe(fileURL: URL, language: String = "zh") async throws -> String {
        guard ["zh", "en"].contains(language) else { throw TranscriptionError.language }
        let audio: AVAudioFile
        do {
            audio = try AVAudioFile(forReading: fileURL, commonFormat: .pcmFormatFloat32, interleaved: false)
        } catch {
            throw TranscriptionError.audioFormat
        }
        let format = audio.processingFormat
        guard format.sampleRate.isFinite, format.sampleRate >= 1, format.sampleRate <= 768_000,
              format.channelCount > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8192)
        else { throw TranscriptionError.audioFormat }

        let sourceRate = Int(format.sampleRate.rounded())
        // Whisper 每个窗口最多处理 30 秒。分批解码，把长文件的内存占用限制在一个窗口内。
        let window = sourceRate * 30
        var model: WhisperModel?
        var transcript: [String] = []
        var finished = false
        while !finished {
            try Task.checkCancellation()
            var mono: [Float] = []
            while mono.count < window {
                if audio.framePosition >= audio.length { finished = true; break }
                let count = AVAudioFrameCount(min(window - mono.count, Int(buffer.frameCapacity)))
                do {
                    try audio.read(into: buffer, frameCount: count)
                } catch let error as NSError where error.domain == NSOSStatusErrorDomain && error.code == Int(kAudioFileEndOfFileError) {
                    finished = true
                    break
                } catch {
                    throw TranscriptionError.audioFormat
                }
                let frames = Int(buffer.frameLength)
                if frames == 0 { finished = true; break }
                guard let channels = buffer.floatChannelData else { throw TranscriptionError.audioFormat }
                if format.channelCount == 1 {
                    mono.append(contentsOf: UnsafeBufferPointer(start: channels[0], count: frames))
                } else {
                    for frame in 0..<frames {
                        var sum: Float = 0
                        for channel in 0..<Int(format.channelCount) { sum += channels[channel][frame] }
                        mono.append(sum / Float(format.channelCount))
                    }
                }
            }
            guard mono.count >= sourceRate / 10, mono.contains(where: { abs($0) > 0.0001 }) else { continue }
            if model == nil { model = try await loadModel() }
            try Task.checkCancellation()
            let samples = try resampleAudio(mono, from: sourceRate, to: sampleRate)
            if let model {
                let parameters = STTGenerateParameters(maxTokens: model.defaultGenerationParameters.maxTokens, language: language)
                let result = model.generate(audio: MLXArray(samples), generationParameters: parameters)
                let words = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !words.isEmpty { transcript.append(words) }
            }
        }
        try Task.checkCancellation()
        guard !transcript.isEmpty else { throw TranscriptionError.noSpeech }
        let text = transcript.joined(separator: "\n")
        if language == "zh" {
            return text.applyingTransform(StringTransform("Traditional-Simplified"), reverse: false) ?? text
        }
        return text
    }
}

private enum TranscriptionError: LocalizedError {
    case audioFormat, download, noSpeech, language

    var errorDescription: String? {
        switch self {
        case .audioFormat: return "无法读取音频，请选择可播放的 WAV、M4A、MP3、AIFF 或 CAF 文件。"
        case .download: return "识别模型下载未完成，请检查网络与可用磁盘空间，再重试。"
        case .noSpeech: return "没有识别到说话声，请选择含有人声的音频或重新录音。"
        case .language: return "请选择中文或英语作为录音语言。"
        }
    }
}
