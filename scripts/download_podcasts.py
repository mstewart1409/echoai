"""
Easy German Podcast Downloader
Scrapes https://www.easygerman.org/podcast/episodes (all paginated pages),
finds every episode's audio URL via the sqs-audio-embed data-url attribute,
and downloads each MP3.

Usage:
  uv run --group scripts python scripts/download_podcasts.py [options]
"""

import re
import time
import sys
import argparse
from pathlib import Path

import requests
from requests.exceptions import ConnectionError, Timeout, ChunkedEncodingError
from bs4 import BeautifulSoup
from tqdm import tqdm

# ── Configuration ────────────────────────────────────────────────────────────
BASE_URL = 'https://www.easygerman.org/podcast/episodes'
SITE_ORIGIN = 'https://www.easygerman.org'
OUTPUT_DIR = Path(__file__).resolve().parent.parent / 'downloads'  # folder where MP3s are saved
REQUEST_DELAY = 1.5  # seconds between HTTP requests
DOWNLOAD_DELAY = 0.5  # seconds between file downloads
CHUNK_SIZE = 1024 * 64  # 64 KB per streaming chunk
MAX_RETRIES = 4  # attempts before giving up
RETRY_BACKOFF = 3.0  # seconds for first retry (doubles each time)

HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/124.0.0.0 Safari/537.36'
    )
}

session = requests.Session()
session.headers.update(HEADERS)

# ── Helpers ──────────────────────────────────────────────────────────────────

_RETRYABLE = (ConnectionError, Timeout, ChunkedEncodingError)


def get_soup(url: str) -> BeautifulSoup:
    """Fetch a URL and return a BeautifulSoup object, retrying on transient errors."""
    delay = RETRY_BACKOFF
    last_exc: Exception = RuntimeError('unreachable')
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = session.get(url, timeout=30)
            resp.raise_for_status()
            return BeautifulSoup(resp.text, 'html.parser')
        except _RETRYABLE as exc:
            last_exc = exc
            if attempt == MAX_RETRIES:
                break
            print(
                f'    ⚠ Request error ({exc}), retrying in {delay:.0f}s '
                f'(attempt {attempt}/{MAX_RETRIES})...'
            )
            time.sleep(delay)
            delay *= 2
    raise last_exc


def make_absolute(href: str) -> str:
    """Convert a relative href to an absolute URL."""
    return href if href.startswith('http') else SITE_ORIGIN + href


def collect_episode_urls(limit: int | None = None) -> list[str]:
    """
    Walk paginated listing pages and return a deduplicated list of episode
    detail-page URLs.  Stops fetching new pages as soon as *limit* URLs have
    been collected (pass None to collect all).
    """
    episode_urls: list[str] = []
    seen: set[str] = set()
    page_url = BASE_URL
    page_num = 1

    while page_url:
        print(f'  Listing page {page_num}: {page_url}')
        soup = get_soup(page_url)

        # Pick links whose visible text starts with a number followed by ':'
        for a in soup.find_all('a', href=re.compile(r'/podcast/episodes/\d+$')):
            text = a.get_text(strip=True)
            href = make_absolute(a['href'])
            if re.match(r'^\d+:', text) and href not in seen:
                seen.add(href)
                episode_urls.append(href)
                if limit is not None and len(episode_urls) >= limit:
                    return episode_urls

        # Follow only the "Older Posts" link — exclude "Newer Posts" which also
        # has ?offset= but carries reversePaginate=true and loops back.
        older = next(
            (
                a
                for a in soup.find_all('a', href=True)
                if re.search(r'older\s*posts', a.get_text(), re.I)
            ),
            None,
        )
        if older:
            page_url = make_absolute(older['href'])
        else:
            page_url = None
        page_num += 1
        if page_url:
            time.sleep(REQUEST_DELAY)

    return episode_urls


def get_audio_url(episode_url: str) -> str | None:
    """
    Visit an individual episode page and return the audio URL extracted from
    the Squarespace audio embed block's data-url attribute.

    The URL is a traffic.libsyn.com link that redirects to a signed CDN URL
    at download time — no JavaScript rewriting required.
    """
    soup = get_soup(episode_url)
    embed = soup.find('div', class_='sqs-audio-embed', attrs={'data-url': True})
    if embed:
        return embed['data-url']
    # Fallback: regex search anywhere in the page HTML
    m = re.search(r'data-url=["\']([^"\']+\.mp3[^"\']*)["\']', str(soup))
    return m.group(1) if m else None


def sanitize_filename(name: str) -> str:
    """Strip characters that are illegal in Windows filenames."""
    return re.sub(r'[\\/:*?"<>|]', '_', name)


def download_file(url: str, dest: Path) -> None:
    """Stream-download *url* to *dest*, following redirects, with retries and a tqdm progress bar."""
    if dest.exists() and dest.stat().st_size > 0:
        print(f'    ↷ Already exists, skipping: {dest.name}')
        return

    delay = RETRY_BACKOFF
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with session.get(url, stream=True, timeout=60, allow_redirects=True) as resp:
                resp.raise_for_status()
                total = int(resp.headers.get('content-length', 0))
                with (
                    open(dest, 'wb') as fh,
                    tqdm(
                        total=total,
                        unit='B',
                        unit_scale=True,
                        desc=dest.name[:50],
                        leave=False,
                    ) as bar,
                ):
                    for chunk in resp.iter_content(chunk_size=CHUNK_SIZE):
                        fh.write(chunk)
                        bar.update(len(chunk))
            return  # success
        except _RETRYABLE as exc:
            # Remove partial file before retrying
            if dest.exists():
                dest.unlink()
            if attempt == MAX_RETRIES:
                raise
            print(
                f'    ⚠ Download error ({exc}), retrying in {delay:.0f}s '
                f'(attempt {attempt}/{MAX_RETRIES})...'
            )
            time.sleep(delay)
            delay *= 2


# ── Main ─────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description='Download Easy German podcast episodes.')
    parser.add_argument(
        '-n',
        '--limit',
        type=int,
        default=None,
        metavar='N',
        help='Maximum number of episodes to download (default: all).',
    )
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(exist_ok=True)

    print('=== Step 1: Collecting episode URLs from all listing pages ===')
    episode_urls = collect_episode_urls(limit=args.limit)
    print(f'\nFound {len(episode_urls)} episodes total.')

    if args.limit is not None:
        print(f'(Limited to {args.limit})\n')
    else:
        print()

    print('=== Step 2: Downloading audio files ===')
    failed: list[tuple[str, str]] = []

    for idx, ep_url in enumerate(episode_urls, 1):
        ep_slug = ep_url.rstrip('/').split('/')[-1]  # e.g. "654"
        print(f'[{idx}/{len(episode_urls)}] Episode {ep_slug} — {ep_url}')

        try:
            time.sleep(REQUEST_DELAY)
            audio_url = get_audio_url(ep_url)
            if not audio_url:
                print('    ✗ No audio URL found, skipping.')
                failed.append((ep_url, 'no audio URL'))
                continue

            # Derive a safe filename: NNN_egpNNN.mp3
            raw_name = audio_url.split('?')[0].split('/')[-1]  # e.g. 'egp654.mp3'
            filename = sanitize_filename(f'{ep_slug}_{raw_name}')
            dest = OUTPUT_DIR / filename

            print(f'    ↓ {audio_url[:80]}...')
            time.sleep(DOWNLOAD_DELAY)
            download_file(audio_url, dest)
            print(f'    ✓ Saved: {dest}')

        except Exception as exc:
            print(f'    ✗ Error: {exc}', file=sys.stderr)
            failed.append((ep_url, str(exc)))

    print('\n=== Done ===')
    print(f'Downloaded to: {OUTPUT_DIR.resolve()}')
    if failed:
        print(f'\nFailed ({len(failed)}):')
        for url, reason in failed:
            print(f'  {url}  →  {reason}')


if __name__ == '__main__':
    main()
