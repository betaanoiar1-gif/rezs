import socket
import wave
from array import array
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from app.services import voice


TEXT = "Offline speech synthesis is working correctly."


def _read_pcm(path: Path):
    with wave.open(str(path), "rb") as audio:
        assert audio.getnchannels() == 1
        assert audio.getsampwidth() == 2
        assert audio.getframerate() > 0
        frames = audio.readframes(audio.getnframes())
        duration = audio.getnframes() / audio.getframerate()
    return frames, duration


def test_local_espeak_provider_is_recognized():
    assert voice.is_local_espeak_voice("local_espeak:en")
    assert not voice.is_local_espeak_voice("en-US-JennyNeural")
    assert not voice.is_local_espeak_voice(None)


def test_local_espeak_generates_real_decodable_non_silent_pcm(tmp_path):
    output = tmp_path / "speech.wav"
    result = voice.tts(TEXT, "local_espeak:en", 1.0, str(output), 1.0)

    assert result is not None
    assert output.is_file()
    assert output.stat().st_size > 44
    frames, duration = _read_pcm(output)
    samples = array("h", frames)
    assert duration > 0
    assert samples
    assert max(abs(sample) for sample in samples) > 0


def test_local_espeak_rejects_empty_or_invalid_input(tmp_path):
    assert voice.local_espeak_tts("", "en", str(tmp_path / "empty.wav")) is None
    assert voice.local_espeak_tts(TEXT, "", str(tmp_path / "no-voice.wav")) is None
    assert voice.local_espeak_tts(TEXT, "not-a-real-voice", str(tmp_path / "bad.wav")) is None


def test_local_espeak_can_generate_repeatedly(tmp_path):
    for index in range(3):
        output = tmp_path / f"speech-{index}.wav"
        assert voice.tts(f"Repeated offline synthesis number {index}.", "local_espeak:en", 1.0, str(output)) is not None
        frames, duration = _read_pcm(output)
        assert frames and duration > 0


def test_local_espeak_serializes_concurrent_native_callbacks(tmp_path):
    def synthesize(index):
        output = tmp_path / f"concurrent-{index}.wav"
        result = voice.tts(f"Concurrent offline synthesis number {index}.", "local_espeak:en", 1.0, str(output))
        return result, output

    with ThreadPoolExecutor(max_workers=3) as executor:
        outputs = list(executor.map(synthesize, range(3)))
    for result, output in outputs:
        assert result is not None
        frames, duration = _read_pcm(output)
        assert frames and duration > 0


def test_local_espeak_performs_no_network_access(tmp_path):
    output = tmp_path / "offline.wav"
    with patch.object(socket, "create_connection", side_effect=AssertionError("network access attempted")), patch(
        "requests.sessions.Session.request", side_effect=AssertionError("HTTP access attempted")
    ):
        assert voice.tts(TEXT, "local_espeak:en", 1.0, str(output)) is not None
    assert output.stat().st_size > 44
