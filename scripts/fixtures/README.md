# fixtures

## `speech-16k.wav`

The positive control for `scripts/vad-test.mjs`: genuine speech, at the rate
the model expects.

It exists because a test that only proves silence, a tone and noise are
*rejected* cannot detect a model that rejects everything. The first Silero
build this project tested scored 0.0031 on real speech -- identical to
silence -- and every negative check passed.

Provenance: generated on macOS with

    say -o speech.aiff "Hello there, this is a real human voice speaking words."
    afconvert -f WAVE -d LEI16@16000 -c 1 speech.aiff speech-16k.wav

so it is machine-synthesised speech rather than a recording of a person. That
matters for licensing (no performer, no consent to obtain) and it is enough
for the job: Silero scores it 0.9998 at peak, which is what the test asserts.

Keep it mono, 16 kHz, 16-bit PCM, and keep the WAV chunk layout -- the test
walks the chunks deliberately, because `afconvert` inserts a `FLLR` chunk
before `data` and an offset of 44 reads silence and concludes the model is
broken. That has already happened once.
