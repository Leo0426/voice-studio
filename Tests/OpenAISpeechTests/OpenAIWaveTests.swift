import AVFoundation
import Foundation
import Testing
@testable import OpenAISpeech

struct OpenAIWaveTests {
    // FFmpeg 写出的同一段 22,050 Hz 音频，前者从管道输出，后者为带 ds64 的 RF64 文件。
    private let stream = Data(base64Encoded: "UklGRv////9XQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAATElTVBoAAABJTkZPSVNGVA0AAABMYXZmNjMuMS4xMDIAAGRhdGH/////AAArAzYGAgl0C3AN5A7BD/4PmQ+VDv0M4QpXCHkFYwI0/w78EPlY9gL0JvLW8CHwDPCa8MTxfvO49Vn4")!
    private let rf64 = Data(base64Encoded: "UkY2NP////9XQVZFZHM2NBwAAACmAAAAAAAAADwAAAAAAAAAHgAAAAAAAAAAAAAAZm10IBAAAAABAAEAIlYAAESsAAACABAATElTVBoAAABJTkZPSVNGVA0AAABMYXZmNjMuMS4xMDIAAGRhdGH/////AAArAzYGAgl0C3AN5A7BD/4PmQ+VDv0M4QpXCHkFYwI0/w78EPlY9gL0JvLW8CHwDPCa8MTxfvO49Vn4")!

    private func client(model: OpenAISynthesisModel, wave: Data) -> OpenAISpeechClient {
        OpenAISpeechClient(key: { "fixture" }) { request in
            let speech = model == .speech
            #expect(request.url?.path == (speech ? "/v1/audio/speech" : "/v1/chat/completions"))
            let body = speech ? wave : try JSONSerialization.data(withJSONObject: [
                "choices": [["finish_reason": "stop", "message": ["audio": ["data": wave.base64EncodedString()]]]]
            ])
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                           headerFields: ["Content-Type": speech ? "audio/wav" : "application/json"])!
            return (body, response)
        }
    }

    @Test(arguments: OpenAISynthesisModel.allCases)
    func streamedAndRF64WaveProducePlayableSeekableExports(model: OpenAISynthesisModel) async throws {
        var options = OpenAISynthesisOptions()
        options.model = model
        var streamedRF64 = rf64
        streamedRF64.resetBytes(in: 20..<44)
        for fixture in [stream, rf64, streamedRF64] {
            let wave = try await client(model: model, wave: fixture).synthesize(text: "读出文字。", options: options)
            #expect(wave.starts(with: "RIFF".utf8))
            #expect(wave[4..<8].elementsEqual([UInt8(wave.count - 8), 0, 0, 0]))
            #expect(wave.suffix(60) == fixture.suffix(60))
            let player = try AVAudioPlayer(data: wave)
            #expect(abs(player.duration - 30 / 22_050.0) < 0.00001)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID()).wav")
            defer { try? FileManager.default.removeItem(at: url) }
            try wave.write(to: url)
            let file = try AVAudioFile(forReading: url)
            #expect(file.length == 30)
            let samples = try #require(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 30))
            try file.read(into: samples)
            #expect(samples.frameLength == 30)
            #expect(samples.floatChannelData![0][1] > 0)
        }
    }

    @Test func oddSized24BitPipeOutputKeepsFiveFramesWithOrWithoutPadding() async throws {
        // FFmpeg 输出的 5 帧 32kHz 24 位单声道，每帧 3 字节，管道中未写 RIFF 对齐字节。
        let unpadded = Data(base64Encoded: "UklGRv////9XQVZFZm10ICgAAAD+/wEAAH0AAAB3AQADABgAFgAYAAQAAAABAAAAAAAQAIAAAKoAOJtxTElTVBoAAABJTkZPSVNGVA0AAABMYXZmNjMuMS4xMDIAAGRhdGH/////AAAAADACAFcEAGkGAFsI")!
        for payload in [unpadded, unpadded + Data([0])] {
            let wave = try await client(model: .audio, wave: payload).synthesize(text: "demo", voice: "marin")
            #expect(wave.count == 118)
            #expect(wave[4..<8].elementsEqual([110, 0, 0, 0]))
            #expect(wave[98..<102].elementsEqual([15, 0, 0, 0]))
            #expect(wave[102..<117] == unpadded[102..<117])
            #expect(wave.last == 0)
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID()).wav")
            defer { try? FileManager.default.removeItem(at: file) }
            try wave.write(to: file)
            let audio = try AVAudioFile(forReading: file)
            #expect(audio.length == 5)
            #expect(audio.fileFormat.sampleRate == 32_000)
        }
    }

    @Test func compressedWaveRemainsUnchangedWhenLengthsAreExplicit() async throws {
        // A-law 有独立的编码描述，不能把未知长度的编码包当作 PCM 采样推断。
        let alaw = Data(base64Encoded: "UklGRnwAAABXQVZFZm10IBIAAAAGAAEAQB8AAEAfAAABAAgAAABmYWN0BAAAACgAAABMSVNUGgAAAElORk9JU0ZUDQAAAExhdmY2My4xLjEwMgAAZGF0YSgAAADVk5qT1RMaE9WTmpPVExoT1ZOak9UTGhPVk5qT1RMaE9WTmpPVExoT")!
        let result = try await client(model: .audio, wave: alaw).synthesize(text: "demo", voice: "marin")
        #expect(result == alaw)
        var unknown = alaw
        unknown.replaceSubrange(4..<8, with: [255, 255, 255, 255])
        unknown.replaceSubrange(88..<92, with: [255, 255, 255, 255])
        await #expect(throws: (any Error).self) {
            try await client(model: .audio, wave: unknown).synthesize(text: "demo", voice: "marin")
        }
    }

    @Test func corruptStreamedAndRF64PayloadsAreRejected() async {
        var invalidFormat = stream
        invalidFormat[32] = 1 // 声明为 16 位单声道，但每帧仅一字节。
        var incorrectRF64Length = rf64
        incorrectRF64Length[28] += 8
        var incorrectRF64Frames = rf64
        incorrectRF64Frames[36] += 1
        var oversizedRF64 = rf64
        oversizedRF64[27] = 0xff
        var oversizedTable = rf64
        oversizedTable[44] = 0xff
        let rawSamples = Data(stream.suffix(60))
        for bad in [stream.dropLast(), stream.dropLast(60), invalidFormat, rf64.dropLast(2), incorrectRF64Length,
                    incorrectRF64Frames, oversizedRF64, oversizedTable, rawSamples] {
            await #expect(throws: (any Error).self) {
                try await client(model: .audio, wave: bad).synthesize(text: "hello", voice: "marin")
            }
        }
    }
}
