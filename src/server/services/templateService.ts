import type { SKRSContext2D, Canvas, Image } from '@napi-rs/canvas';
import type { TemplateId } from '../../shared/types.js';

export interface TemplateRenderOptions {
  ctx: SKRSContext2D;
  canvas: Canvas;
  title: string;
  platformName: string;
  fontFamily: string;
  logoImage: Image | null;
}

type TemplateRenderer = (options: TemplateRenderOptions) => void;

// ── Helper: wrap text into lines that fit maxWidth ────────────────────────────
function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  let line = '';
  const lines: string[] = [];

  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && n > 0) {
      lines.push(line.trim());
      line = words[n] + ' ';
    } else {
      line = testLine;
    }
  }
  lines.push(line.trim());
  return lines;
}

// ── Template 1: dark_gradient ─────────────────────────────────────────────────
// Current behavior: linear gradient bottom→mid, semi-transparent text box at bottom,
// platform name centered at ~50%, logo 150px top-right.
const darkGradient: TemplateRenderer = ({ ctx, canvas, title, platformName, fontFamily, logoImage }) => {
  const W = canvas.width;
  const H = canvas.height;

  // Gradient overlay
  const gradient = ctx.createLinearGradient(0, H, 0, H / 2);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0.9)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, H);

  // Title text
  ctx.font = `bold 70px ${fontFamily}`;
  ctx.fillStyle = 'white';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const lines = wrapText(ctx, title, W);
  const lineHeight = 60;
  const yOffset = H - lines.length * lineHeight - 10;

  // Semi-transparent text box
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(0, yOffset - 20, W, lines.length * lineHeight + 40);

  // Draw title lines
  ctx.fillStyle = 'white';
  lines.forEach((ln, i) => {
    ctx.fillText(ln, W / 2, yOffset + i * lineHeight);
  });

  // Platform name centered at ~50%
  ctx.font = `bold 30px ${fontFamily}`;
  ctx.fillStyle = 'white';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(platformName, W / 2, H / 2);

  // Logo top-right
  if (logoImage) {
    const logoWidth = 150;
    const logoHeight = (logoImage.height / logoImage.width) * logoWidth;
    ctx.drawImage(logoImage, W - logoWidth - 10, 10, logoWidth, logoHeight);
  }
};

// ── Template 2: solid_bar ─────────────────────────────────────────────────────
// Opaque dark bar at bottom 35%, thin white accent line at bar top,
// title left-aligned in bar, platform name bottom-left, logo 120px at bar-top right.
const solidBar: TemplateRenderer = ({ ctx, canvas, title, platformName, fontFamily, logoImage }) => {
  const W = canvas.width;
  const H = canvas.height;
  const barH = Math.round(H * 0.35);
  const barY = H - barH;

  // Dark bar
  ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.fillRect(0, barY, W, barH);

  // White accent line at bar top
  ctx.fillStyle = 'white';
  ctx.fillRect(0, barY, W, 3);

  // Title left-aligned
  ctx.font = `bold 62px ${fontFamily}`;
  ctx.fillStyle = 'white';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  const lines = wrapText(ctx, title, W - 160);
  const lineHeight = 68;
  const titleY = barY + 30;
  lines.forEach((ln, i) => {
    ctx.fillText(ln, 30, titleY + i * lineHeight);
  });

  // Platform name bottom-left
  ctx.font = `bold 26px ${fontFamily}`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(platformName, 30, H - 20);

  // Logo 120px at top of bar, right side
  if (logoImage) {
    const logoWidth = 120;
    const logoHeight = (logoImage.height / logoImage.width) * logoWidth;
    ctx.drawImage(logoImage, W - logoWidth - 20, barY - logoHeight / 2, logoWidth, logoHeight);
  }
};

// ── Template 3: minimal ───────────────────────────────────────────────────────
// Full-image darkening, large bold centered text, no background box,
// platform name near bottom, logo centered at top.
const minimal: TemplateRenderer = ({ ctx, canvas, title, platformName, fontFamily, logoImage }) => {
  const W = canvas.width;
  const H = canvas.height;

  // Full darkening
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fillRect(0, 0, W, H);

  // Large centered title, no box
  ctx.font = `bold 80px ${fontFamily}`;
  ctx.fillStyle = 'white';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const lines = wrapText(ctx, title, W - 80);
  const lineHeight = 90;
  const totalH = lines.length * lineHeight;
  const startY = H / 2 - totalH / 2 + lineHeight / 2;
  lines.forEach((ln, i) => {
    ctx.fillText(ln, W / 2, startY + i * lineHeight);
  });

  // Platform name near bottom
  ctx.font = `bold 28px ${fontFamily}`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(platformName, W / 2, H - 30);

  // Logo centered horizontally at top
  if (logoImage) {
    const logoWidth = 140;
    const logoHeight = (logoImage.height / logoImage.width) * logoWidth;
    ctx.drawImage(logoImage, W / 2 - logoWidth / 2, 20, logoWidth, logoHeight);
  }
};

// ── Template 4: split ─────────────────────────────────────────────────────────
// Left-half darkened with gradient fading to right, title left-aligned on left half,
// platform name bottom-left, logo top-left.
const split: TemplateRenderer = ({ ctx, canvas, title, platformName, fontFamily, logoImage }) => {
  const W = canvas.width;
  const H = canvas.height;

  // Left-half gradient fading right
  const gradient = ctx.createLinearGradient(0, 0, W * 0.75, 0);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0.8)');
  gradient.addColorStop(0.6, 'rgba(0, 0, 0, 0.4)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, H);

  // Title left-aligned on left half (max 480px)
  ctx.font = `bold 66px ${fontFamily}`;
  ctx.fillStyle = 'white';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const lines = wrapText(ctx, title, 480);
  const lineHeight = 72;
  const totalH = lines.length * lineHeight;
  const startY = H / 2 - totalH / 2 + lineHeight / 2;
  lines.forEach((ln, i) => {
    ctx.fillText(ln, 40, startY + i * lineHeight);
  });

  // Platform name bottom-left
  ctx.font = `bold 26px ${fontFamily}`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(platformName, 40, H - 30);

  // Logo top-left
  if (logoImage) {
    const logoWidth = 120;
    const logoHeight = (logoImage.height / logoImage.width) * logoWidth;
    ctx.drawImage(logoImage, 30, 20, logoWidth, logoHeight);
  }
};

// ── Template 5: vignette ──────────────────────────────────────────────────────
// Radial dark gradient from edges, additional bottom darken,
// title with text shadow near bottom, platform name near bottom centered, logo top-right.
const vignette: TemplateRenderer = ({ ctx, canvas, title, platformName, fontFamily, logoImage }) => {
  const W = canvas.width;
  const H = canvas.height;

  // Radial vignette from edges
  const radial = ctx.createRadialGradient(W / 2, H / 2, W * 0.3, W / 2, H / 2, W * 0.8);
  radial.addColorStop(0, 'rgba(0, 0, 0, 0)');
  radial.addColorStop(1, 'rgba(0, 0, 0, 0.75)');
  ctx.fillStyle = radial;
  ctx.fillRect(0, 0, W, H);

  // Additional bottom darken
  const bottomGrad = ctx.createLinearGradient(0, H * 0.55, 0, H);
  bottomGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
  bottomGrad.addColorStop(1, 'rgba(0, 0, 0, 0.7)');
  ctx.fillStyle = bottomGrad;
  ctx.fillRect(0, 0, W, H);

  // Title with text shadow near bottom
  ctx.font = `bold 70px ${fontFamily}`;
  ctx.fillStyle = 'white';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;

  const lines = wrapText(ctx, title, W - 80);
  const lineHeight = 76;
  const totalH = lines.length * lineHeight;
  const baseY = H - 70;
  lines.forEach((ln, i) => {
    ctx.fillText(ln, W / 2, baseY - (lines.length - 1 - i) * lineHeight);
  });

  // Reset shadow
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  // Platform name near bottom centered
  ctx.font = `bold 28px ${fontFamily}`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(platformName, W / 2, baseY - totalH - 20);

  // Logo top-right
  if (logoImage) {
    const logoWidth = 140;
    const logoHeight = (logoImage.height / logoImage.width) * logoWidth;
    ctx.drawImage(logoImage, W - logoWidth - 15, 15, logoWidth, logoHeight);
  }
};

// ── Registry & main export ────────────────────────────────────────────────────
export const TEMPLATE_REGISTRY: Record<TemplateId, TemplateRenderer> = {
  dark_gradient: darkGradient,
  solid_bar: solidBar,
  minimal,
  split,
  vignette,
};

export function renderTemplate(options: TemplateRenderOptions & { templateId: TemplateId }): void {
  const { templateId, ...rest } = options;
  const renderer = TEMPLATE_REGISTRY[templateId] ?? darkGradient;
  renderer(rest);
}
