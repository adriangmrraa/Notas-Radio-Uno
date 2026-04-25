import { createCanvas, loadImage } from "@napi-rs/canvas";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { getFontFamily } from "./fontService.js";
import { renderTemplate } from "./templateService.js";
import type { BrandingConfig, AttributedQuote } from "../../shared/types.js";

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

function wrapText(ctx: any, text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export async function processQuoteFlyer(
  quote: AttributedQuote,
  speakerPhotoData: Buffer | null,
  branding: BrandingConfig | null,
): Promise<string> {
  const canvas = createCanvas(1080, 1080);
  const ctx = canvas.getContext('2d');

  // 1. Background: radial gradient
  const gradient = ctx.createRadialGradient(540, 540, 0, 540, 540, 760);
  gradient.addColorStop(0, '#1a1a2e');
  gradient.addColorStop(1, '#0a0a0f');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1080, 1080);

  // 2. Decorative opening quote mark
  ctx.font = 'bold 200px serif';
  ctx.fillStyle = 'rgba(232, 201, 126, 0.15)';
  ctx.fillText('"', 80, 200);

  // 3. Quote text (centered, white, bold)
  const fontFamily = branding ? getFontFamily(branding.fontFamily) : 'sans-serif';
  ctx.font = `bold 46px ${fontFamily}`;
  ctx.fillStyle = 'white';
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 10;

  let lines = wrapText(ctx, quote.quote, 820);
  if (lines.length > 5) {
    lines = lines.slice(0, 5);
    const last = lines[4];
    lines[4] = last.length > 3 ? last.slice(0, -3) + '...' : '...';
  }

  const blockHeight = lines.length * 65;
  const availableStart = 220;
  const availableEnd = 720;
  const availableHeight = availableEnd - availableStart;
  const startY = availableStart + (availableHeight - blockHeight) / 2 + 46; // +46 for baseline offset

  lines.forEach((line, index) => {
    ctx.fillText(line, 540, startY + index * 65);
  });

  // Reset shadow
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;

  // 4. Separator line
  ctx.fillStyle = 'rgba(232, 201, 126, 0.3)';
  ctx.fillRect(440, 760, 200, 2);

  // 5. Speaker photo (circle, diameter 100px, centered at x=540, y=830)
  ctx.save();
  ctx.beginPath();
  ctx.arc(540, 830, 50, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (speakerPhotoData) {
    const photo = await loadImage(speakerPhotoData);
    ctx.drawImage(photo, 490, 780, 100, 100);
  } else {
    ctx.fillStyle = '#444';
    ctx.fill();
  }
  ctx.restore();

  // 6. Speaker name
  ctx.font = `bold 26px ${fontFamily}`;
  ctx.fillStyle = 'white';
  ctx.textAlign = 'center';
  ctx.fillText(quote.speaker, 540, 905);

  // 7. Speaker role
  ctx.font = `20px ${fontFamily}`;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.textAlign = 'center';
  ctx.fillText(quote.role ?? '', 540, 935);

  // 8. Platform name (bottom center)
  const platformName = branding?.platformName ?? 'Noticias';
  ctx.font = `16px ${fontFamily}`;
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.textAlign = 'center';
  ctx.fillText(platformName, 540, 1040);

  // 9. Logo (top right, if available) — non-fatal if fails
  if (branding?.logoBuffer) {
    try {
      const logoImage = await loadImage(branding.logoBuffer);
      ctx.drawImage(logoImage, 1080 - 120 - 10, 10, 120, (logoImage.height / logoImage.width) * 120);
    } catch (_) {
      // non-fatal
    }
  }

  // 10. Save to file and return path
  const buffer = canvas.toBuffer('image/jpeg');
  const outputPath = path.join(PROJECT_ROOT, 'output', `quote_${uuidv4()}.jpg`);
  await fs.writeFile(outputPath, buffer);
  return outputPath;
}

export { processImage };
