import Foundation
#if canImport(Darwin)
import Darwin
#endif

public enum MemoryProbe {
    /// The footprint iOS charges to this process (what jetsam acts on), in MB. Returns -1 if unavailable.
    public static func footprintMB() -> Double {
        #if canImport(Darwin)
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) { ptr in
            ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return kr == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576.0 : -1
        #else
        return -1
        #endif
    }
}

/// Samples the footprint on a background queue while a block of work runs; ``peakMB`` is the maximum seen.
public final class PeakSampler {
    private let queue = DispatchQueue(label: "fieldvoice.peak-sampler")
    private let lock = NSLock()
    private var running = false
    private var peak: Double = 0

    public init() {}

    public var peakMB: Double {
        lock.lock(); defer { lock.unlock() }
        return peak
    }

    public func start(intervalMs: Int = 50) {
        lock.lock(); running = true; peak = MemoryProbe.footprintMB(); lock.unlock()
        queue.async { [weak self] in
            while let self = self {
                self.lock.lock()
                let go = self.running
                if go { self.peak = max(self.peak, MemoryProbe.footprintMB()) }
                self.lock.unlock()
                if !go { break }
                Thread.sleep(forTimeInterval: Double(intervalMs) / 1000.0)
            }
        }
    }

    @discardableResult
    public func stop() -> Double {
        lock.lock(); running = false; peak = max(peak, MemoryProbe.footprintMB()); let p = peak; lock.unlock()
        return p
    }
}
