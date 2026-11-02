# Device probe - profile `dev-box-quiet`

- Intel(R) Core(TM) Ultra 7 165H (16C/22T), 63.6 GB RAM, Windows 11
- _Not a field-fleet device: results rank options only and are not representative of the Latitude 7220 (8th-gen U-series CPU, <=16 GB LPDDR3, no NPU)._
- _This CPU has an NPU; auto-selected NPU variants may be used unless variants are pinned._

## Speech-to-text

| Engine | Cold start ms | Resident MB | Audio s | p50 ms | best ms | worst ms | RTF (p50) |
|---|---|---|---|---|---|---|---|
| `foundry:stt:whisper-tiny:cpu` | 1712 | 113 | 8.2 | 770 | 528 | 803 | 0.09 |
| `foundry:stt:whisper-base:cpu` | 2282 | 159 | 8.2 | 1153 | 1089 | 1295 | 0.14 |
| `foundry:stt:whisper-small:cpu` | 3526 | 379 | 8.2 | 3649 | 3486 | 3879 | 0.45 |
| `foundry:stt:whisper-medium:cpu` | 4319 | 930 | 8.2 | 9471 | 8725 | 9526 | 1.16 |
| `foundry:stt:nemotron-speech-streaming-en-0.6b:cpu` | 2176 | 483 | 8.2 | 3706 | 3466 | 3915 | 0.45 |

_RTF below 1.0 keeps up with the speaker; the last transcript of each engine:_

- `foundry:stt:whisper-tiny:cpu`: 'I replaced the transformer at pole 1 2 3. The old unit was leaking oil and I installed unit 4 5 6.'
- `foundry:stt:whisper-base:cpu`: 'I replaced the transformer at pole 123. The old unit was leaking oil and I installed unit 456.'
- `foundry:stt:whisper-small:cpu`: 'I replaced the transformer at pole 1 2 3. The old unit was leaking oil and I installed unit 4 5 6.'
- `foundry:stt:whisper-medium:cpu`: 'I replaced the transformer at pole 1-2-3. The old unit was leaking oil and I installed unit 4-5-6.'
- `foundry:stt:nemotron-speech-streaming-en-0.6b:cpu`: 'I replaced the transformer at pole one two three. The old unit was leaking oil and I installed unit four five six'

## Live (the clip streamed in real time)

| Engine | First words after ms | Wait after the last word, p50 ms | best ms | worst ms |
|---|---|---|---|---|
| `foundry:stt:whisper-tiny:cpu` | batch engine: the worker waits for the whole processing time above | | | |
| `foundry:stt:whisper-base:cpu` | batch engine: the worker waits for the whole processing time above | | | |
| `foundry:stt:whisper-small:cpu` | batch engine: the worker waits for the whole processing time above | | | |
| `foundry:stt:whisper-medium:cpu` | batch engine: the worker waits for the whole processing time above | | | |
| `foundry:stt:nemotron-speech-streaming-en-0.6b:cpu` | 700 | 191 | 175 | 239 |

_The wait after the last word is what the worker feels: a batch engine only starts when the recording stops, so its wait is the whole p50 above._

