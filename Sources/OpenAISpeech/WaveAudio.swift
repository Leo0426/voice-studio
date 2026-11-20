import Foundation

/// 将完整 HTTP 响应里的流式 WAV 转成可定位的 RIFF 文件，保留原来的音频格式和采样。
enum WaveAudio {
    static func finalized(_ input: Data) -> Data? {
        var wave = input.startIndex == 0 ? input : Data(input)
        guard wave.count >= 44, wave[8..<12].elementsEqual("WAVE".utf8), wave.count - 8 < UInt32.max else { return nil }
        let rf64 = wave.starts(with: "RF64".utf8)
        guard rf64 || wave.starts(with: "RIFF".utf8) else { return nil }
        let riffSize = wave.uint32(at: 4)
        var end = riffSize == UInt32.max ? wave.count : Int(riffSize) + 8
        guard end <= wave.count else { return nil }

        var declaredDataSize: Int?
        var declaredFrames: UInt64 = 0
        var offset = 12
        if rf64 {
            // RF64 在 ds64 中给出实际长度。FFmpeg 的不可定位管道会把三项都保留为零。
            guard riffSize == .max, end >= 48, wave[12..<16].elementsEqual("ds64".utf8) else { return nil }
            let ds64Size = Int(wave.uint32(at: 16))
            guard ds64Size >= 28, ds64Size <= end - 20,
                  wave.uint32(at: 44) == 0 else { return nil }
            let riff = wave.uint64(at: 20), samples = wave.uint64(at: 28)
            declaredFrames = wave.uint64(at: 36)
            if riff != 0 || samples != 0 || declaredFrames != 0 {
                guard riff == UInt64(end - 8), samples > 0, samples <= UInt64(end) else { return nil }
                declaredDataSize = Int(samples)
            }
            wave.replaceSubrange(0..<4, with: "RIFF".utf8)
            wave.replaceSubrange(12..<16, with: "JUNK".utf8)
            offset = 20 + ds64Size + ds64Size % 2
        }

        var format: SampleFormat?
        var hasData = false
        while offset + 8 <= end {
            let chunk = wave[offset..<offset + 4]
            let length = wave.uint32(at: offset + 4)
            let start = offset + 8
            let isData = chunk.elementsEqual("data".utf8)
            var count = Int(length)
            if length == .max {
                guard isData else { return nil }
                if let declaredDataSize {
                    count = declaredDataSize
                } else {
                    // 只有带完整固定帧格式的末块才能由响应边界确定长度。
                    guard case let .linear(frameBytes) = format else { return nil }
                    count = end - start
                    if count > 0, count % frameBytes != 0, count.isMultiple(of: 2), wave[end - 1] == 0,
                       (count - 1).isMultiple(of: frameBytes) { count -= 1 }
                }
                wave.writeSize(count, at: offset + 4)
            }
            guard count <= end - start else { return nil }
            if chunk.elementsEqual("fmt ".utf8) {
                guard format == nil, let parsed = sampleFormat(in: wave, at: start, count: count) else { return nil }
                format = parsed
            }
            if isData {
                guard let format, !hasData, count > 0 else { return nil }
                if let declaredDataSize, declaredDataSize != count { return nil }
                if case let .linear(frameBytes) = format {
                    guard count.isMultiple(of: frameBytes),
                          declaredFrames == 0 || declaredFrames == UInt64(count / frameBytes) else { return nil }
                }
                // 不可定位的 FFmpeg 管道有时不给末尾奇数长度的完整数据块补齐。
                if !count.isMultiple(of: 2), start + count == end, length == .max, riffSize == .max,
                   declaredDataSize == nil, wave.count - 7 < UInt32.max {
                    wave.append(0)
                    end += 1
                }
                hasData = true
            }
            offset = start + count + count % 2
        }
        guard hasData, offset == end else { return nil }
        if riffSize == .max { wave.writeSize(end - 8, at: 4) }
        return wave
    }

    private enum SampleFormat { case linear(frameBytes: Int), compressed }

    private static func sampleFormat(in wave: Data, at start: Int, count: Int) -> SampleFormat? {
        guard count >= 16 else { return nil }
        var tag = wave.uint16(at: start)
        if tag == 0xfffe {
            // WAVE_FORMAT_EXTENSIBLE 的 SubFormat GUID 区分 PCM 和 IEEE float。
            let guidSuffix: [UInt8] = [0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]
            guard count >= 40, (22...count - 18).contains(Int(wave.uint16(at: start + 16))) else { return nil }
            if !wave[start + 26..<start + 40].elementsEqual(guidSuffix) { return nil }
            tag = wave.uint16(at: start + 24)
        }
        let channels = Int(wave.uint16(at: start + 2)), rate = Int(wave.uint32(at: start + 4))
        let block = Int(wave.uint16(at: start + 12)), bits = Int(wave.uint16(at: start + 14))
        guard tag > 0, channels > 0, rate > 0, block > 0 else { return nil }
        guard tag == 1 || tag == 3 else { return .compressed }
        guard (tag != 3 || [32, 64].contains(bits)), bits > 0,
              block == channels * ((bits + 7) / 8), Int(wave.uint32(at: start + 8)) == rate * block else { return nil }
        return .linear(frameBytes: block)
    }
}

private extension Data {
    func uint16(at index: Int) -> UInt16 { withUnsafeBytes { $0.loadUnaligned(fromByteOffset: index, as: UInt16.self).littleEndian } }
    func uint32(at index: Int) -> UInt32 { withUnsafeBytes { $0.loadUnaligned(fromByteOffset: index, as: UInt32.self).littleEndian } }
    func uint64(at index: Int) -> UInt64 { withUnsafeBytes { $0.loadUnaligned(fromByteOffset: index, as: UInt64.self).littleEndian } }

    mutating func writeSize(_ size: Int, at index: Int) {
        Swift.withUnsafeBytes(of: UInt32(size).littleEndian) { replaceSubrange(index..<index + 4, with: $0) }
    }
}
