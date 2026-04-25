import { createCanvas, loadImage } from "@napi-rs/canvas";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { getFontFamily } from "./fontService.js";
import { renderTemplate } from "./templateService.js";
import type { BrandingConfig } from "../../shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const PLATFORM_NAME = process.env.PLATFORM_NAME || "Noticias";

async function processImage(imagePath: string, title: string, branding?: BrandingConfig): Promise<string> {
  const uniqueId = uuidv4();
  const resizedImagePath = path.join(PROJECT_ROOT, "output", `resized_${uniqueId}.jpg`);
  const finalImagePath = path.join(PROJECT_ROOT, "output", `final_${uniqueId}.jpg`);
  const logoPath = path.join(PROJECT_ROOT, "public", "logo.png");

  // Resolve branding values (use provided branding or fall back to defaults)
  // getFontFamily returns the CSS font-family string (e.g., `"Bebas Kai"`)
  // The template service uses it as-is when composing ctx.font = `bold 70px ${fontFamily}`
  const fontFamily = branding ? getFontFamily(branding.fontFamily) : '"Bebas Kai"';
  const platformName = branding ? branding.platformName : PLATFORM_NAME;
  const templateId = branding ? branding.templateId : 'dark_gradient';

  try {
    await sharp(imagePath).resize(1080, 1080).toFile(resizedImagePath);
    const image = await loadImage(resizedImagePath);
    const canvas = createCanvas(1080, 1080);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, 1080, 1080);

    // Load logo image
    let logoImage = null;
    if (branding && branding.logoBuffer) {
      try {
        logoImage = await loadImage(branding.logoBuffer);
      } catch (_) {
        // Fall back to file logo
        try { logoImage = await loadImage(logoPath); } catch (_) { /* no logo */ }
      }
    } else {
      try { logoImage = await loadImage(logoPath); } catch (_) { /* no logo */ }
    }

    if (branding) {
      // Use template-based rendering
      renderTemplate({
        ctx,
        canvas,
        title,
        platformName,
        fontFamily,
        logoImage,
        templateId,
      });
    } else {
      // Legacy behavior: hardcoded dark_gradient logic (backward compat)
      const gradient = ctx.createLinearGradient(0, 1080, 0, 540);
      gradient.addColorStop(0, "rgba(0, 0, 0, 0.9)");
      gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 1080, 1080);

      ctx.font = 'bold 70px "Bebas Kai"';
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

      ctx.font = 'bold 30px "Bebas Kai"';
      ctx.fillStyle = "white";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(PLATFORM_NAME, 540, 1080 / 2);

      if (logoImage) {
        const logoWidth = 150;
        const logoHeight = (logoImage.height / logoImage.width) * logoWidth;
        ctx.drawImage(logoImage, 1080 - logoWidth - 10, 10, logoWidth, logoHeight);
      }
    }

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
