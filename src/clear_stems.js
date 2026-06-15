// empty_stems.js
outlets = 1;

// Change this path to your stems folder
var folderPath = "/Users/alexandregagne/Desktop/EBYS/EBYS_INFRA/stems";

function clear() {
    var f = new Folder(folderPath);

    if (!f) {
        post("Cannot open folder: " + folderPath + "\n");
        return;
    }

    f.reset();
    var fname = f.filename;

    while (fname !== null) {
        try {
            // Only delete .wav files (stems)
            if (!fname.startsWith(".") && fname.endsWith(".wav")) {
                var filePath = folderPath + "/" + fname;
                var fileObj = new File(filePath, "write", "TEXT");
                if (fileObj.isopen) {
                    fileObj.close();
                }
                // Delete file
                var deleted = File.remove(filePath);
                if (deleted)
                    post("Deleted: " + fname + "\n");
                else
                    post("Failed to delete: " + fname + "\n");
            }
        } catch (e) {
            post("Error handling file: " + fname + "\n");
        }

        if (!f.next()) break;
        fname = f.filename;
    }

    f.close();
    post("Stem folder cleared.\n");
}