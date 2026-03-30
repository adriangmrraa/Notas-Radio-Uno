import { Router, Request, Response } from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');

const router = Router();

/**
 * POST /api/images/edit
 * Edita una imagen existente usando Gemini con un prompt del usuario.
 * Body: { imagePath: string, prompt: string }
 * Returns: { success: true, imagePath: string, imageUrl: string }
 */
router.post('/edit', async (req: Request, res: Response) => {
    try {
        const { imagePath, prompt } = req.body;

        if (!imagePath || !prompt) {
            res.status(400).json({ error: 'imagePath y prompt son requeridos' });
            return;
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            res.status(500).json({ error: 'GEMINI_API_KEY no configurada en el servidor' });
            return;
        }

        // Resolve the image path (could be relative like "output/final_xxx.jpg" or absolute)
        let fullImagePath = imagePath;
        if (!path.isAbsolute(imagePath)) {
            fullImagePath = path.join(PROJECT_ROOT, imagePath);
        }

        if (!fs.existsSync(fullImagePath)) {
            res.status(404).json({ error: 'Imagen no encontrada en el servidor' });
            return;
        }

        // Read image and convert to base64
        const imageData = fs.readFileSync(fullImagePath);
        const base64Image = imageData.toString('base64');
        const mimeType = fullImagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

        // Build Gemini request with original image + edit prompt
        const model = 'gemini-2.0-flash-exp';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const systemPrompt = [
            'Eres un editor de imágenes profesional.',
            'El usuario te proporciona una imagen y una instrucción de edición.',
            'Debes generar una NUEVA imagen basada en la imagen original aplicando los cambios solicitados.',
            'Mantén el estilo, la composición y la calidad de la imagen original.',
            'La imagen resultante debe ser cuadrada (1:1) y de alta calidad.',
            'NO agregues texto, letras, logos ni marcas de agua a menos que se solicite explícitamente.',
        ].join(' ');

        const body = {
            contents: [
                {
                    role: 'user',
                    parts: [
                        { inlineData: { mimeType, data: base64Image } },
                        { text: `${systemPrompt}\n\nInstrucción del usuario: ${prompt}` },
                    ],
                },
            ],
            generationConfig: {
                responseModalities: ['TEXT', 'IMAGE'],
                imageConfig: {
                    aspectRatio: '1:1',
                    imageSize: '1K',
                },
            },
        };

        console.log('[ImageEdit] Enviando imagen + prompt a Gemini...');
        console.log('[ImageEdit] Prompt:', prompt);

        const response = await axios.post(url, body, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 120000, // 2 minutes for image editing
        });

        // Extract image from response
        const candidate = response.data.candidates?.[0];
        const candidateParts = candidate?.content?.parts || [];
        const imagePart = candidateParts.find(
            (p: { inlineData?: { data?: string } }) => p.inlineData?.data
        );

        if (!imagePart?.inlineData?.data) {
            // Try to extract text feedback if no image
            const textPart = candidateParts.find(
                (p: { text?: string }) => p.text
            );
            const feedback = textPart?.text || 'Gemini no generó una imagen';
            console.error('[ImageEdit] No se recibió imagen:', feedback);
            res.status(422).json({ error: feedback });
            return;
        }

        // Save the edited image
        const editedFilename = `edited_${uuidv4()}.jpg`;
        const editedPath = path.join(OUTPUT_DIR, editedFilename);
        fs.writeFileSync(editedPath, Buffer.from(imagePart.inlineData.data, 'base64'));

        console.log('[ImageEdit] Imagen editada guardada:', editedPath);

        res.json({
            success: true,
            imagePath: `output/${editedFilename}`,
            imageUrl: `/output/${editedFilename}`,
        });
    } catch (error: unknown) {
        const axiosErr = error as { response?: { data?: unknown }; message?: string };
        const detail = axiosErr.response?.data
            ? JSON.stringify(axiosErr.response.data).slice(0, 500)
            : axiosErr.message;
        console.error('[ImageEdit] Error:', detail);
        res.status(500).json({ error: 'Error al editar la imagen con Gemini', detail });
    }
});

export { router as imageEditRouter };
