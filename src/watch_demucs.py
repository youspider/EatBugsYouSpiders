import subprocess
import time
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# =========================
# PATHS
# =========================
BASE_DIR = Path("/Users/alexandregagne/Documents/EBYS/EBYS_INFRA")

RAW_UPLOADS = BASE_DIR / "raw_uploads"
STEMS_DIR = BASE_DIR / "stems"
TEMP_DIR = BASE_DIR / "temp"

RAW_UPLOADS.mkdir(exist_ok=True)
STEMS_DIR.mkdir(exist_ok=True)
TEMP_DIR.mkdir(exist_ok=True)

processed = set()


# =========================
# WATCHER HANDLER
# =========================
class AudioHandler(FileSystemEventHandler):

    def process_file(self, filepath: Path):

        print("\n========================")
        print("NEW FILE:", filepath)
        print("========================")

        if filepath in processed:
            print("Already processed")
            return
        processed.add(filepath)

        ext = filepath.suffix.lower()

        # -------------------------
        # INPUT HANDLING
        # -------------------------
        if ext == ".mp4":
            wav_path = TEMP_DIR / f"{filepath.stem}.wav"

            subprocess.run([
                "ffmpeg", "-y",
                "-i", str(filepath),
                str(wav_path)
            ])

            target_audio = wav_path

        elif ext == ".wav":
            target_audio = filepath

        else:
            print("Unsupported file type")
            return

        print("Processing:", target_audio.name)

        # -------------------------
        # RUN DEMUCS
        # -------------------------
        subprocess.run([
            "python", "-m", "demucs",
            "-o", str(STEMS_DIR),
            str(target_audio)
        ])

        print("Demucs finished")

        # -------------------------
        # FIND OUTPUT FOLDER (SAFE METHOD)
        # -------------------------
        ht = STEMS_DIR / "htdemucs"

        if not ht.exists():
            print("No htdemucs folder found")
            return

        # find folder that actually contains wav files
        song_folder = None
        wav_files = []

        for folder in ht.iterdir():
            if folder.is_dir():
                files = list(folder.glob("*.wav"))
                if files:
                    song_folder = folder
                    wav_files = files
                    break

        if song_folder is None:
            print("No valid Demucs output found")
            return

        print("Using folder:", song_folder.name)

        original_name = target_audio.stem

        # -------------------------
        # RENAME FILES
        # -------------------------
        for f in wav_files:

            new_name = f"{original_name}_{f.stem}.wav"
            new_path = f.parent / new_name

            print(f"Renaming {f.name} -> {new_name}")

            try:
                f.rename(new_path)
            except Exception as e:
                print("Rename error:", e)

        print("DONE\n")


    def on_created(self, event):

        if event.is_directory:
            return

        print("🔥 WATCHER TRIGGERED:", event.src_path)

        time.sleep(2)
        self.process_file(Path(event.src_path))


# =========================
# START WATCHER
# =========================
observer = Observer()
observer.schedule(AudioHandler(), str(RAW_UPLOADS), recursive=False)
observer.start()

print("Watching raw_uploads...")

try:
    while True:
        time.sleep(1)

except KeyboardInterrupt:
    observer.stop()

observer.join()
