/**
 * Save a text file from the app. On iPhone the share sheet is the reliable way to
 * save from a home-screen app; elsewhere it falls back to a normal download.
 */
export async function saveTextFile(name: string, text: string, type = "text/csv"): Promise<void> {
  const file = new File([text], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (err) {
      // Cancelling the share sheet is not a failure: don't start a second, unwanted download.
      if (err instanceof DOMException && err.name === "AbortError") return;
      /* share isn't usable here; fall through to a normal download */
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Give the browser a moment to start the download before releasing the file.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
