import fs from "node:fs/promises";
import path from "node:path";

export async function writeRunTextFile(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (text.length === 0) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.writeFile(filePath, text, "utf8");
}

