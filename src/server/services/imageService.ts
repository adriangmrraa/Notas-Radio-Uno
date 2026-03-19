import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

async function processImage(imagePath: string, title: string): Promise<string> {
  const uniqueId = uuidv4();
  const resizedImagePath = path.join(PROJECT_ROOT, "output", `resized_${uniqueId}.jpg`);
  const finalImagePath = path.join(PROJECT_ROOT, "output", `final_${uniqueId}.jpg`);
  const logoPath = path.join(PROJECT_ROOT, "public", "logo.png");

  try {
    await sharp(imagePath).resize(1080, 1080).toFile(resizedImagePath);
    const image = await loadImage(resizedImagePath);
    const canvas = createCanvas(1080, 1080);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, 1080, 1080);
    const gradient = ctx.createLinearGradient(0, 1080, 0, 540);
    gradient.addColorStop(0, "rgba(0, 0, 0, 0.9)");
    gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1080, 1080);

    // Register font: search in project first, then OS-specific system paths
    const fontPaths: string[] = [
      path.join(PROJECT_ROOT, "fonts", "BebasKai.ttf"),
      path.join(PROJECT_ROOT, "public", "BebasKai.ttf"),
    ];

    // Add system paths based on OS
    if (process.platform === "win32") {
      fontPaths.push(path.join(process.env.WINDIR || "C:\\Windows", "Fonts", "BebasKai.ttf"));
      fontPaths.push(path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Windows", "Fonts", "BebasKai.ttf"));
    } else if (process.platform === "darwin") {
      fontPaths.push("/Library/Fonts/BebasKai.ttf");
      fontPaths.push(path.join(process.env.HOME || "", "Library/Fonts/BebasKai.ttf"));
    } else {
      fontPaths.push("/usr/share/fonts/truetype/BebasKai.ttf");
      fontPaths.push("/usr/local/share/fonts/BebasKai.ttf");
      fontPaths.push(path.join(process.env.HOME || "", ".local/share/fonts/BebasKai.ttf"));
    }

    let fontRegistered = false;
    for (const fp of fontPaths) {
      try {
        if (existsSync(fp)) {
          GlobalFonts.registerFromPath(fp, "Bebas Kai");
          fontRegistered = true;
          break;
        }
      } catch (_) {
        // Continue to next font path
      }
    }

    ctx.font = fontRegistered ? 'bold 70px "Bebas Kai"' : 'bold 60px "Arial Black", "Impact", sans-serif';
    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const maxWidth = 1080;
    const words = title.split(" ");
    let line = "";
    const lines: string[] = [];

    for (let n = 0; n < words.length; n++) {
      const testLine = line + words[n] + " ";
      const metrics = ctx.measureText(testLine);
      const testWidth = metrics.width;
      if (testWidth > maxWidth && n > 0) {
        lines.push(line.trim());
        line = words[n] + " ";
      } else {
        line = testLine;
      }
    }
    lines.push(line.trim());

    const yOffset = 1080 - lines.length * 80 - 10;
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(0, yOffset - 20, 1080, lines.length * 60 + 40);
    ctx.fillStyle = "white";
    lines.forEach((ln, index) => {
      ctx.fillText(ln, 540, yOffset + index * 60);
    });

    ctx.font = fontRegistered ? 'bold 30px "Bebas Kai"' : 'bold 28px "Arial Black", "Impact", sans-serif';
    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Radio Uno Formosa", 540, 1080 / 2);

    const logo = await loadImage(logoPath);
    const logoWidth = 150;
    const logoHeight = (logo.height / logo.width) * logoWidth;
    ctx.drawImage(logo, 1080 - logoWidth - 10, 10, logoWidth, logoHeight);

    const buffer = canvas.toBuffer("image/jpeg");
    await fs.writeFile(finalImagePath, buffer);
    await fs.unlink(resizedImagePath);

    return finalImagePath;
  } catch (error) {
    console.error("Error al procesar la imagen:", error);
    throw error;
  }
}

export { processImage };
