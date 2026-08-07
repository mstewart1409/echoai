"""
Easy German Podcast Transcriber
Uses OpenAI Whisper (local, free, no API key) to transcribe every MP3 in the
downloads/ folder and writes transcripts to transcripts/.

Usage:
  uv run --group scripts python scripts/transcribe_podcasts.py [options]

Model sizes (downloaded automatically on first use):
  tiny   ~75 MB  – fastest, least accurate
  base   ~145 MB – good for quick tests
  small  ~461 MB – recommended default for German
  medium ~1.5 GB – better accuracy, slower
  large  ~2.9 GB – best accuracy, slowest

Requirements:
  pip install openai-whisper
  ffmpeg must be on PATH  (winget install ffmpeg)
"""

import argparse
import json
import sys
import os
import shutil
import subprocess
from pathlib import Path

import whisper
from tqdm import tqdm

# ── Configuration ────────────────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DOWNLOADS_DIR = PROJECT_ROOT / 'downloads'
TRANSCRIPTS_DIR = PROJECT_ROOT / 'transcripts'
DEFAULT_MODEL = 'medium'
LANGUAGE = 'de'  # German — improves accuracy and speed


# ── Helpers ──────────────────────────────────────────────────────────────────


def format_timestamp(seconds: float) -> str:
    """Convert seconds to SRT timestamp: HH:MM:SS,mmm"""
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1_000)
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'


def write_txt(segments: list[dict], dest: Path) -> None:
    """Plain text: one paragraph per segment."""
    text = '\n'.join(seg['text'].strip() for seg in segments)
    dest.write_text(text, encoding='utf-8')


def write_srt(segments: list[dict], dest: Path) -> None:
    """SRT subtitle file with timestamps."""
    lines = []
    for i, seg in enumerate(segments, 1):
        lines.append(str(i))
        lines.append(f'{format_timestamp(seg["start"])} --> {format_timestamp(seg["end"])}')
        lines.append(seg['text'].strip())
        lines.append('')
    dest.write_text('\n'.join(lines), encoding='utf-8')


def write_json(segments: list[dict], dest: Path) -> None:
    """
    JSON file with full Whisper segment data including embedded word-level timing.
    Each segment contains: id, seek, start, end, text, tokens, temperature,
    avg_logprob, compression_ratio, no_speech_prob, and a 'words' list with
    per-word start/end/probability when word_timestamps=True is used.
    """
    dest.write_text(json.dumps(segments, indent=2, ensure_ascii=False), encoding='utf-8')


WRITERS = {
    'txt': write_txt,
    'srt': write_srt,
    'json': write_json,
}


def resolve_ffmpeg(ffmpeg_path: Path | None) -> str:
    """
    Resolve ffmpeg availability before transcribing.

    If --ffmpeg-path is provided, it may point to ffmpeg.exe or a folder
    containing ffmpeg.exe. We prepend that folder to PATH for Whisper's
    internal 'ffmpeg' command.
    """
    candidate: str | None = None

    if ffmpeg_path is not None:
        p = ffmpeg_path.expanduser().resolve()
        if p.is_dir():
            exe = p / 'ffmpeg.exe'
            if exe.exists():
                os.environ['PATH'] = f'{str(p)};{os.environ.get("PATH", "")}'
                candidate = str(exe)
        elif p.is_file():
            os.environ['PATH'] = f'{str(p.parent)};{os.environ.get("PATH", "")}'
            candidate = str(p)

    if candidate is None:
        found = shutil.which('ffmpeg')
        if found:
            candidate = found

    if candidate is None:
        raise FileNotFoundError(
            'ffmpeg not found. Install it (winget install ffmpeg), open a new terminal, '
            'or pass --ffmpeg-path to ffmpeg.exe or its bin folder.'
        )

    # Verify executable actually runs
    subprocess.run(
        [candidate, '-version'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    return candidate


# ── Main ─────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description='Transcribe Easy German MP3s using local Whisper.')
    parser.add_argument(
        '--model',
        '-m',
        default=DEFAULT_MODEL,
        choices=['tiny', 'base', 'small', 'medium', 'large'],
        help=f'Whisper model to use (default: {DEFAULT_MODEL}).',
    )
    parser.add_argument(
        '--format',
        '-f',
        default='json',
        choices=list(WRITERS) + ['all'],
        dest='fmt',
        help='Output format: txt, srt, json (default, includes word timing), or all.',
    )
    parser.add_argument(
        '--language',
        '-l',
        default=LANGUAGE,
        help=f'Audio language code passed to Whisper (default: {LANGUAGE}).',
    )
    parser.add_argument(
        '--input',
        '-i',
        type=Path,
        default=DOWNLOADS_DIR,
        help=f'Folder containing MP3 files (default: {DOWNLOADS_DIR}).',
    )
    parser.add_argument(
        '--limit',
        '-n',
        type=int,
        default=None,
        help='Only transcribe the first N MP3 files (default: all).',
    )
    parser.add_argument(
        '--ffmpeg-path',
        type=Path,
        default=None,
        help='Path to ffmpeg.exe or its containing folder (optional).',
    )
    args = parser.parse_args()

    try:
        ffmpeg_exe = resolve_ffmpeg(args.ffmpeg_path)
        print(f'Using ffmpeg: {ffmpeg_exe}')
    except Exception as exc:
        print(f'Error: {exc}', file=sys.stderr)
        sys.exit(1)

    if not args.input.is_dir():
        print(f'Error: input folder not found: {args.input}', file=sys.stderr)
        sys.exit(1)

    mp3_files = sorted(args.input.glob('*.mp3'))
    if args.limit is not None:
        mp3_files = mp3_files[: args.limit]
    if not mp3_files:
        print(f'No MP3 files found in {args.input.resolve()}')
        sys.exit(0)

    TRANSCRIPTS_DIR.mkdir(exist_ok=True)

    formats_to_write = list(WRITERS.keys()) if args.fmt == 'all' else [args.fmt]

    files_to_transcribe: list[Path] = []
    skipped_existing: list[str] = []

    for mp3 in mp3_files:
        all_outputs_exist = True
        for fmt in formats_to_write:
            out_path = TRANSCRIPTS_DIR / mp3.with_suffix(f'.{fmt}').name
            if not (out_path.exists() and out_path.stat().st_size > 0):
                all_outputs_exist = False
                break

        if all_outputs_exist:
            skipped_existing.append(mp3.name)
        else:
            files_to_transcribe.append(mp3)

    if not files_to_transcribe:
        print('All requested transcripts already exist; nothing to transcribe.')
        print(f'Checked {len(mp3_files)} file(s) in {args.input.resolve()}')
        sys.exit(0)

    print(f"Loading Whisper model '{args.model}'...")
    model = whisper.load_model(args.model)
    print(
        f'Model loaded. Transcribing {len(files_to_transcribe)} file(s) → {TRANSCRIPTS_DIR.resolve()}'
    )
    if skipped_existing:
        print(f'Skipping {len(skipped_existing)} already transcribed file(s).')
    print()

    failed: list[tuple[str, str]] = []

    for idx, mp3 in enumerate(tqdm(files_to_transcribe, unit='file', desc='Transcribing'), 1):
        tqdm.write(f'[{idx}/{len(files_to_transcribe)}] Transcribing: {mp3.name}')
        try:
            result = model.transcribe(
                str(mp3),
                language=args.language,
                verbose=False,
                word_timestamps=True,
            )

            for fmt in formats_to_write:
                out_path = TRANSCRIPTS_DIR / mp3.with_suffix(f'.{fmt}').name

                if out_path.exists() and out_path.stat().st_size > 0:
                    tqdm.write(f'    ↷ {fmt}: already exists, skipping')
                    continue

                WRITERS[fmt](result['segments'], out_path)
                tqdm.write(f'    ✓ Saved {fmt}: {out_path.name}')

        except Exception as exc:
            tqdm.write(f'  ✗ Error: {exc}', file=sys.stderr)
            failed.append((mp3.name, str(exc)))

    print('\n=== Done ===')
    print(f'Transcripts saved to: {TRANSCRIPTS_DIR.resolve()}')
    if failed:
        print(f'\nFailed ({len(failed)}):')
        for name, reason in failed:
            print(f'  {name}  →  {reason}')


if __name__ == '__main__':
    main()
