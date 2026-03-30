import { useState } from 'react';
import { Wand2, Loader2, RotateCcw, Check, AlertCircle } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog';

interface ImageEditModalProps {
  imageUrl: string;      // URL to display (e.g. /output/final_xxx.jpg)
  imagePath: string;     // Path to send to server (e.g. output/final_xxx.jpg)
  onClose: () => void;
  onSave: (newImagePath: string, newImageUrl: string) => void;
}

export function ImageEditModal({ imageUrl, imagePath, onClose, onSave }: ImageEditModalProps) {
  const { fetchApi } = useApi();
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editedUrl, setEditedUrl] = useState<string | null>(null);
  const [editedPath, setEditedPath] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState(imageUrl);

  const handleEdit = async () => {
    if (!prompt.trim()) return;
    setLoading(true);
    setError('');

    try {
      const result = await fetchApi<{ success: boolean; imagePath: string; imageUrl: string }>(
        '/images/edit',
        {
          method: 'POST',
          body: {
            imagePath: editedPath || imagePath,
            prompt: prompt.trim(),
          },
        }
      );

      if (result?.success) {
        setEditedUrl(result.imageUrl);
        setEditedPath(result.imagePath);
        setCurrentUrl(result.imageUrl + '?t=' + Date.now()); // cache bust
        setPrompt('');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al editar la imagen');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setEditedUrl(null);
    setEditedPath(null);
    setCurrentUrl(imageUrl);
    setError('');
  };

  const handleConfirm = () => {
    if (editedUrl && editedPath) {
      onSave(editedPath, editedUrl);
    }
    onClose();
  };

  const suggestions = [
    'Mejorar la iluminación y contraste',
    'Cambiar el fondo a un estudio de noticias',
    'Hacer la imagen más dramática y periodística',
    'Ajustar los colores para que sea más cálida',
    'Agregar un efecto de profundidad de campo',
  ];

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl bg-zinc-900 border-zinc-800 text-white max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500/15 to-purple-500/10 flex items-center justify-center text-cyan-400">
              <Wand2 className="w-5 h-5" />
            </div>
            <div>
              <DialogTitle className="text-lg font-bold text-white">Editor de Imagen con IA</DialogTitle>
              <DialogDescription className="text-xs text-white/30">
                Gemini edita la imagen con tu instrucción
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Body */}
        <div className="space-y-6">
          {/* Image Preview */}
          <div className="relative rounded-2xl overflow-hidden border border-white/[0.06] bg-black/30">
            <img
              src={currentUrl}
              alt="Preview"
              className="w-full max-h-[400px] object-contain"
            />
            {loading && (
              <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex flex-col items-center justify-center gap-3">
                <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
                <p className="text-sm text-white/60">Gemini está editando la imagen...</p>
              </div>
            )}
            {editedUrl && !loading && (
              <div className="absolute top-3 right-3 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/20 text-emerald-400 text-xs">
                <Check className="w-3 h-3" />
                Editada
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-3 p-4 rounded-xl bg-red-500/[0.06] border border-red-500/15 text-red-400 text-sm">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Prompt Input */}
          <div>
            <label className="text-xs font-semibold text-white/35 uppercase tracking-wider mb-2 block">
              Instrucción de edición
            </label>
            <div className="relative">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe qué cambios quieres en la imagen..."
                rows={3}
                className="w-full resize-none rounded-xl bg-white/[0.03] border border-white/[0.06] text-white/70 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/30 transition-all placeholder:text-white/20"
                disabled={loading}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleEdit();
                  }
                }}
              />
            </div>
          </div>

          {/* Quick Suggestions */}
          <div>
            <p className="text-xs text-white/25 mb-2 font-medium">Sugerencias rápidas:</p>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => setPrompt(s)}
                  disabled={loading}
                  className="text-xs px-3 py-1.5 rounded-full bg-white/[0.03] border border-white/[0.06] text-white/40 hover:text-white/70 hover:bg-white/[0.06] hover:border-white/[0.1] transition-all duration-200 cursor-pointer disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="gap-2 sm:gap-0">
          {editedUrl && (
            <button onClick={handleReset} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/[0.06] border border-white/[0.1] text-white/70 hover:text-white hover:bg-white/[0.1] transition-all mr-auto">
              <RotateCcw className="w-4 h-4" />
              Restaurar original
            </button>
          )}
          <button
            onClick={handleEdit}
            disabled={loading || !prompt.trim()}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-white font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Editando...
              </>
            ) : (
              <>
                <Wand2 className="w-4 h-4" />
                Editar con IA
              </>
            )}
          </button>
          {editedUrl && (
            <button onClick={handleConfirm} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-emerald-500 to-emerald-600 text-white font-medium shadow-[0_4px_20px_rgba(16,185,129,0.2)] hover:from-emerald-400 hover:to-emerald-500 transition-all">
              <Check className="w-4 h-4" />
              Usar esta imagen
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
