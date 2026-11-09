// Adds Split Insights to the app menu (after `npm run app:build`). Under WSL, Windows
// picks up Linux app launchers, so it shows in the Start menu too, in the Ubuntu folder.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const here = resolve(import.meta.dirname, "..");
const binary = join(here, "src-tauri/target/release/split-insights");
const icon = join(here, "src-tauri/icons/128x128@2x.png");
if (!existsSync(binary)) {
  console.error("Build it first: npm run app:build");
  process.exit(1);
}

const dir = join(homedir(), ".local/share/applications");
mkdirSync(dir, { recursive: true });
const file = join(dir, "split-insights.desktop");
writeFileSync(
  file,
  [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Split Insights",
    "Comment=Where the money goes, from your own statements",
    `Exec="${binary}"`,
    `Icon=${icon}`,
    "Terminal=false",
    "Categories=Office;Finance;",
    "",
  ].join("\n"),
);
console.log(`Added ${file}.`);
console.log("It's in your app menu; under WSL, in the Windows Start menu's Ubuntu folder (it can take a minute).");
