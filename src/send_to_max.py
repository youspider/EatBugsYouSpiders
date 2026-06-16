import os
import time

folder = "/Users/alexandregagne/Documents/EBYS/EBYS_INFRA/stems/htdemucs"
out_file = "/Users/alexandregagne/Documents/EBYS/EBYS_INFRA/stream.txt"

last_content = None

while True:
    lines = []

    for root, dirs, files in os.walk(folder):
        for f in files:
            if not f.endswith(".wav"):
                continue

            path = os.path.join(root, f)
            name = f.lower()

            if "drum" in name or "kick" in name or "snare" in name:
                stem = "drums"
            elif "bass" in name:
                stem = "bass"
            elif "vocal" in name or "vox" in name:
                stem = "melody"
            elif "other" in name:
                stem = "melody"
            else:
                continue

            lines.append(f"{stem} {path}")

    content = "\n".join(lines)

    # only write + print if changed
    if content != last_content:
        with open(out_file, "w") as f:
            f.write(content)

        print("updated:", len(lines), "stems")
        last_content = content

    time.sleep(0.5)
