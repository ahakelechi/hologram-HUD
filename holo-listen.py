#!/usr/bin/env python
"""
HOLO // NEXUS - local speech to text.

Captures the microphone, waits for you to stop talking, transcribes locally
with faster-whisper, and posts the text to holo-bridge.js, which passes it to
the wallpaper.

This exists because Wallpaper Engine's embedded browser can open a microphone
but cannot transcribe: Chromium uploads audio to a speech service and the
embedded build has no keys for it. Doing recognition here removes that
dependency entirely and works with no network at all.

Audio comes in through ffmpeg rather than a Python audio package, because
ffmpeg is already present and pyaudio/sounddevice are not - and installing a
binary wheel to capture a microphone is a poor trade when a subprocess pipe
does the same job.

Usage
    python holo-listen.py                       # listen on the default mic
    python holo-listen.py --list-devices
    python holo-listen.py --device "Microphone Array (2- Realtek(R) Audio)"
    python holo-listen.py --model tiny          # faster, less accurate
    python holo-listen.py --file clip.wav       # transcribe a file, no mic
    python holo-listen.py --dry-run             # print, do not post
"""
import argparse
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

FFMPEG = r"C:\ffmpeg\bin\ffmpeg.exe"
RATE = 16000            # what whisper wants; resampling here avoids doing it later
FRAME_MS = 30
FRAME_BYTES = int(RATE * 2 * FRAME_MS / 1000)   # 16-bit mono

# --- speech gating -------------------------------------------------------
# A fixed threshold fails on every machine but the one it was tuned on, so the
# noise floor is measured at startup and the gate floats above it.
CALIBRATE_SEC = 1.2
SPEECH_MULT = 3.2       # how far above the floor counts as speech
SILENCE_HANG = 0.70     # seconds of quiet that end an utterance
MIN_SPEECH = 0.35       # ignore coughs, clicks and door slams
MAX_UTTER = 15.0        # hard stop, so one noisy room cannot buffer forever
PREROLL = 0.30          # keep audio from just before the gate opened


def log(msg):
    print("[%s] %s" % (time.strftime("%H:%M:%S"), msg), flush=True)


def list_devices():
    p = subprocess.run([FFMPEG, "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
                       capture_output=True, text=True)
    names = re.findall(r'"([^"]+)"\s*\(audio\)', p.stderr)
    if not names:
        log("no audio devices found")
    for n in names:
        print("  " + n)
    return names


def default_device():
    names = re.findall(
        r'"([^"]+)"\s*\(audio\)',
        subprocess.run([FFMPEG, "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
                       capture_output=True, text=True).stderr)
    # Prefer a real microphone over virtual devices, which are usually
    # loopbacks and would transcribe whatever the machine is playing.
    for n in names:
        low = n.lower()
        if "microphone" in low and not any(v in low for v in ("virtual", "steam", "oculus")):
            return n
    return names[0] if names else None


def open_stream(device):
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error",
           "-f", "dshow", "-i", "audio=" + device,
           "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"]
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=FRAME_BYTES * 4)


def rms(buf, np):
    a = np.frombuffer(buf, dtype=np.int16).astype(np.float32) / 32768.0
    if a.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(a * a)))


def post(url, text, dry):
    if dry:
        log("dry-run, not posting")
        return
    try:
        req = urllib.request.Request(url, data=json.dumps({"text": text}).encode("utf-8"),
                                     headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=3) as r:
            body = json.loads(r.read().decode("utf-8"))
            log("posted -> %d client(s)" % body.get("delivered", 0))
    except urllib.error.URLError as e:
        log("bridge unreachable (%s) - is holo-bridge.js running?" % e.reason)
    except Exception as e:
        log("post failed: %s" % e)


# Bigger models are better but need the memory to be there. On a busy machine
# `medium` can fail to allocate outright, so rather than dying with a
# traceback the loader steps down through smaller models until one fits.
SMALLER = {"large-v3": "medium", "large": "medium", "medium": "small",
           "small": "base", "base": "tiny", "tiny": None}


def load_model(name, prefer_gpu):
    from faster_whisper import WhisperModel
    tried = []
    while name:
        # CTranslate2 needs its own CUDA runtime, separate from torch's - so
        # GPU is attempted and quietly dropped rather than assumed to work.
        if prefer_gpu:
            try:
                m = WhisperModel(name, device="cuda", compute_type="float16")
                log("model '%s' on gpu" % name)
                return m
            except Exception as e:
                log("gpu unavailable (%s); using cpu" % str(e).split("\n")[0][:60])
        try:
            m = WhisperModel(name, device="cpu", compute_type="int8")
            log("model '%s' on cpu (int8)" % name)
            if tried:
                log("note: fell back from %s - not enough free memory" % ", ".join(tried))
            return m
        except (RuntimeError, MemoryError) as e:
            msg = str(e).split("\n")[0][:80]
            tried.append(name)
            nxt = SMALLER.get(name)
            if not nxt:
                log("could not load any model (%s)" % msg)
                raise SystemExit(1)
            log("'%s' would not load (%s); trying '%s'" % (name, msg, nxt))
            name = nxt
    raise SystemExit(1)


def transcribe(model, audio, np):
    a = np.frombuffer(audio, dtype=np.int16).astype(np.float32) / 32768.0
    segs, _ = model.transcribe(a, language="en", beam_size=1,
                               condition_on_previous_text=False,
                               vad_filter=True)
    return " ".join(s.text.strip() for s in segs).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device")
    ap.add_argument("--model", default="small")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--file")
    ap.add_argument("--list-devices", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--gpu", action="store_true")
    args = ap.parse_args()

    if args.list_devices:
        list_devices()
        return 0

    import numpy as np
    url = "http://127.0.0.1:%d/say" % args.port
    model = load_model(args.model, args.gpu)

    # --- file mode: everything except the microphone, for testing ---
    if args.file:
        p = subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", args.file,
                            "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"],
                           capture_output=True)
        if p.returncode != 0:
            log("ffmpeg could not read %s" % args.file)
            return 1
        text = transcribe(model, p.stdout, np)
        log("heard: %r" % text)
        if text:
            post(url, text, args.dry_run)
        return 0

    device = args.device or default_device()
    if not device:
        log("no audio input device found; try --list-devices")
        return 1
    log("capturing from: %s" % device)

    proc = open_stream(device)
    if proc.stdout is None:
        log("could not start ffmpeg")
        return 1

    # noise floor
    log("calibrating noise floor, stay quiet for %.1fs..." % CALIBRATE_SEC)
    floor_samples = []
    t_end = time.time() + CALIBRATE_SEC
    while time.time() < t_end:
        chunk = proc.stdout.read(FRAME_BYTES)
        if not chunk:
            break
        floor_samples.append(rms(chunk, np))
    floor = (sum(floor_samples) / len(floor_samples)) if floor_samples else 0.005
    gate = max(0.010, floor * SPEECH_MULT)
    log("noise floor %.4f, speech gate %.4f" % (floor, gate))
    log("listening - say the wake word, e.g. \"nexus what time is it\"  (ctrl-c to stop)")

    preroll_frames = int(PREROLL * 1000 / FRAME_MS)
    preroll, buf = [], bytearray()
    speaking = False
    quiet_for = 0.0
    spoke_for = 0.0

    try:
        while True:
            chunk = proc.stdout.read(FRAME_BYTES)
            if not chunk:
                err = proc.stderr.read().decode("utf-8", "ignore") if proc.stderr else ""
                log("audio stream ended. %s" % err.strip()[:200])
                break
            level = rms(chunk, np)
            if not speaking:
                preroll.append(chunk)
                if len(preroll) > preroll_frames:
                    preroll.pop(0)
                if level > gate:
                    speaking = True
                    buf = bytearray(b"".join(preroll))
                    preroll.clear()
                    buf += chunk
                    spoke_for = FRAME_MS / 1000.0
                    quiet_for = 0.0
            else:
                buf += chunk
                spoke_for += FRAME_MS / 1000.0
                quiet_for = quiet_for + FRAME_MS / 1000.0 if level <= gate else 0.0
                if quiet_for >= SILENCE_HANG or spoke_for >= MAX_UTTER:
                    speaking = False
                    voiced = spoke_for - quiet_for
                    if voiced < MIN_SPEECH:
                        buf = bytearray()
                        continue
                    log("transcribing %.1fs..." % voiced)
                    t0 = time.time()
                    text = transcribe(model, bytes(buf), np)
                    buf = bytearray()
                    if text:
                        log("heard: %r  (%.1fs)" % (text, time.time() - t0))
                        post(url, text, args.dry_run)
                    else:
                        log("nothing recognised")
    except KeyboardInterrupt:
        log("stopping")
    finally:
        try:
            proc.terminate()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
