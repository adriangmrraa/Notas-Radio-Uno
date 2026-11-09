import { Router, type Request, type Response } from "express";

import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import {
    createDrizzleEditorialStore,
    deleteProgramOverride,
    getEffectiveProfile,
    getTenantProfile,
    listProgramOverrideSummaries,
    listPrograms,
    upsertProgramProfile,
    upsertTenantProfile,
    EDITORIAL_FORMATS,
    EDITORIAL_TONES,
    type EditorialProfileShape,
    type EditorialStore,
} from "../services/editorialService.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TONES: readonly string[] = EDITORIAL_TONES;
const VALID_FORMATS: readonly string[] = EDITORIAL_FORMATS;

const MAX_NAME_LENGTH = 120;
const MAX_INDUSTRY_LENGTH = 80;
const MAX_SIGNATURE_LENGTH = 500;
const MAX_TONE_DESCRIPTION_LENGTH = 2000;
const MAX_STYLE_GUIDE_LENGTH = 20000;
const MAX_LIST_ITEMS = 200;
const MAX_LIST_ITEM_LENGTH = 500;
const MAX_FORMAT_ITEMS = 50;
const MAX_FORMAT_ITEM_LENGTH = 80;
const MAX_EXAMPLES = 50;
const MAX_EXAMPLE_TITLE_LENGTH = 200;
const MAX_EXAMPLE_EXCERPT_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Validation — body de PUT /profile y PUT /profile/:programId
// ---------------------------------------------------------------------------
interface ParsedProfileBody {
    fields?: Partial<EditorialProfileShape>;
    error?: string;
}

/**
 * Escalar nullable del body: `undefined` ⇒ ausente; `null` ⇒ null explícito
 * (limpia el campo ⇒ hereda en el merge); string ⇒ trim, y si queda vacío se
 * interpreta como ausente (un "" no pisa al valor heredado con basura).
 */
function normalizeNullableString(
    value: unknown,
    max: number,
    label: string,
): { present: boolean; value?: string | null; error?: string } {
    if (value === undefined) return { present: false };
    if (value === null) return { present: true, value: null };
    if (typeof value !== "string") {
        return { present: false, error: `${label} debe ser un string de hasta ${max} caracteres o null` };
    }
    const trimmed = value.trim();
    if (trimmed === "") return { present: false };
    if (trimmed.length > max) {
        return { present: false, error: `${label} debe ser un string de hasta ${max} caracteres o null` };
    }
    return { present: true, value: trimmed };
}

/**
 * Array de strings del body: cada item se trimea y los vacíos post-trim se
 * descartan; si el array queda vacío se guarda vacío (⇒ hereda en el merge).
 */
function normalizeStringArray(
    value: unknown,
    maxItems: number,
    maxItemLength: number,
    label: string,
): { value?: string[]; error?: string } {
    if (value === undefined) return {};
    if (!Array.isArray(value) || value.length > maxItems) {
        return { error: `${label} debe ser un array de hasta ${maxItems} strings` };
    }
    if (!value.every((item) => typeof item === "string")) {
        return { error: `${label} debe ser un array de strings` };
    }
    const normalized = (value as string[])
        .map((item) => item.trim())
        .filter((item) => item !== "");
    if (normalized.some((item) => item.length > maxItemLength)) {
        return { error: `${label}: cada item admite hasta ${maxItemLength} caracteres` };
    }
    return { value: normalized };
}

export function parseProfileBody(body: unknown): ParsedProfileBody {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { error: "Body inválido" };
    }
    const b = body as Record<string, unknown>;
    const fields: Partial<EditorialProfileShape> = {};

    // tone es requerido en el PUT (es NOT NULL con default 'formal').
    if (typeof b.tone !== "string" || !VALID_TONES.includes(b.tone)) {
        return { error: `tone inválido. Valores permitidos: ${VALID_TONES.join(", ")}` };
    }
    fields.tone = b.tone;

    const scalars = [
        ["name", MAX_NAME_LENGTH],
        ["toneDescription", MAX_TONE_DESCRIPTION_LENGTH],
        ["styleGuide", MAX_STYLE_GUIDE_LENGTH],
        ["industry", MAX_INDUSTRY_LENGTH],
        ["signature", MAX_SIGNATURE_LENGTH],
    ] as const;
    for (const [key, max] of scalars) {
        const parsed = normalizeNullableString(b[key], max, key);
        if (parsed.error) return { error: parsed.error };
        if (parsed.present) {
            (fields as Record<string, unknown>)[key] = parsed.value;
        }
    }

    if (b.isActive !== undefined) {
        if (typeof b.isActive !== "boolean") {
            return { error: "isActive debe ser boolean" };
        }
        fields.isActive = b.isActive;
    }

    for (const key of ["rules", "forbiddenTopics"] as const) {
        const parsed = normalizeStringArray(b[key], MAX_LIST_ITEMS, MAX_LIST_ITEM_LENGTH, key);
        if (parsed.error) return { error: parsed.error };
        if (parsed.value !== undefined) fields[key] = parsed.value;
    }

    if (b.activeFormats !== undefined) {
        const parsed = normalizeStringArray(b.activeFormats, MAX_FORMAT_ITEMS, MAX_FORMAT_ITEM_LENGTH, "activeFormats");
        if (parsed.error) return { error: parsed.error };
        const invalid = (parsed.value as string[]).filter((f) => !VALID_FORMATS.includes(f));
        if (invalid.length > 0) {
            return {
                error: `activeFormats contiene valores inválidos: ${invalid.join(", ")}. Permitidos: ${VALID_FORMATS.join(", ")}`,
            };
        }
        fields.activeFormats = parsed.value;
    }

    if (b.examples !== undefined) {
        if (!Array.isArray(b.examples) || b.examples.length > MAX_EXAMPLES) {
            return { error: `examples debe ser un array de hasta ${MAX_EXAMPLES} ejemplos` };
        }
        const examples: EditorialProfileShape["examples"] = [];
        for (const ex of b.examples) {
            if (
                !ex ||
                typeof ex !== "object" ||
                typeof (ex as { title?: unknown }).title !== "string"
            ) {
                return { error: "examples debe ser un array de {title, excerpt}" };
            }
            const title = (ex as { title: string }).title.trim();
            // Title vacío ⇒ se ignora el ejemplo (no pisa con basura).
            if (title === "") continue;
            const rawExcerpt = (ex as { excerpt?: unknown }).excerpt;
            if (rawExcerpt !== undefined && typeof rawExcerpt !== "string") {
                return { error: "examples debe ser un array de {title, excerpt}" };
            }
            // excerpt opcional ⇒ se guarda como "".
            const excerpt = typeof rawExcerpt === "string" ? rawExcerpt.trim() : "";
            if (title.length > MAX_EXAMPLE_TITLE_LENGTH || excerpt.length > MAX_EXAMPLE_EXCERPT_LENGTH) {
                return {
                    error: `examples: title ≤ ${MAX_EXAMPLE_TITLE_LENGTH} y excerpt ≤ ${MAX_EXAMPLE_EXCERPT_LENGTH} caracteres`,
                };
            }
            examples.push({ title, excerpt });
        }
        fields.examples = examples;
    }

    return { fields };
}

function editorialStore(): EditorialStore {
    return createDrizzleEditorialStore(db);
}

// ---------------------------------------------------------------------------
// Router — mounted at /api/editorial (PC-05)
// ---------------------------------------------------------------------------
export const editorialRouter = Router();

// ------------------------------------------------------------------
// GET /api/editorial/profile — perfil efectivo + default del tenant +
// resumen de overrides por programa. `?programId=` pide el efectivo de
// ese programa (debe ser del tenant).
// ------------------------------------------------------------------
editorialRouter.get("/profile", requireAuth, async (req: Request, res: Response) => {
    try {
        const tenantId = req.auth!.tenantId;
        const store = editorialStore();

        const programId =
            typeof req.query.programId === "string" && req.query.programId.trim() !== ""
                ? req.query.programId.trim()
                : undefined;

        if (programId !== undefined) {
            if (!UUID_RE.test(programId) || !(await store.programBelongsToTenant(tenantId, programId))) {
                res.status(404).json({ error: "Programa no encontrado" });
                return;
            }
        }

        const [effective, tenantProfile, programOverrides, programOverride] = await Promise.all([
            getEffectiveProfile(store, tenantId, programId ?? null),
            getTenantProfile(store, tenantId),
            listProgramOverrideSummaries(store, tenantId),
            programId
                ? store.findProgramProfile(tenantId, programId)
                : Promise.resolve(null),
        ]);

        res.json({ effective, tenantProfile, programOverrides, programOverride });
    } catch (error) {
        console.error("[Editorial] Error al obtener el perfil:", error);
        res.status(500).json({ error: "Error al obtener la línea editorial" });
    }
});

// ------------------------------------------------------------------
// PUT /api/editorial/profile — upsert del perfil default del tenant
// (program_id = null). Campos ausentes no se tocan en update.
// ------------------------------------------------------------------
editorialRouter.put("/profile", requireAuth, async (req: Request, res: Response) => {
    try {
        const tenantId = req.auth!.tenantId;
        const parsed = parseProfileBody(req.body);
        if (parsed.error || !parsed.fields) {
            res.status(400).json({ error: parsed.error ?? "Body inválido" });
            return;
        }

        const profile = await upsertTenantProfile(editorialStore(), tenantId, parsed.fields);
        res.json({ success: true, profile });
    } catch (error) {
        console.error("[Editorial] Error al guardar el perfil:", error);
        res.status(500).json({ error: "Error al guardar la línea editorial" });
    }
});

// ------------------------------------------------------------------
// PUT /api/editorial/profile/:programId — upsert del override de un
// programa (debe existir y ser del tenant).
// ------------------------------------------------------------------
editorialRouter.put("/profile/:programId", requireAuth, async (req: Request, res: Response) => {
    try {
        const tenantId = req.auth!.tenantId;
        const { programId } = req.params;

        if (!UUID_RE.test(programId)) {
            res.status(404).json({ error: "Programa no encontrado" });
            return;
        }

        const parsed = parseProfileBody(req.body);
        if (parsed.error || !parsed.fields) {
            res.status(400).json({ error: parsed.error ?? "Body inválido" });
            return;
        }

        const profile = await upsertProgramProfile(editorialStore(), tenantId, programId, parsed.fields);
        if (!profile) {
            res.status(404).json({ error: "Programa no encontrado" });
            return;
        }

        res.json({ success: true, profile });
    } catch (error) {
        console.error("[Editorial] Error al guardar el override:", error);
        res.status(500).json({ error: "Error al guardar el override editorial" });
    }
});

// ------------------------------------------------------------------
// DELETE /api/editorial/profile/:programId — borra el override del
// programa (NO el default del tenant). El programa vuelve a heredar.
// ------------------------------------------------------------------
editorialRouter.delete("/profile/:programId", requireAuth, async (req: Request, res: Response) => {
    try {
        const tenantId = req.auth!.tenantId;
        const { programId } = req.params;

        if (!UUID_RE.test(programId)) {
            res.status(404).json({ error: "Override no encontrado" });
            return;
        }

        const deleted = await deleteProgramOverride(editorialStore(), tenantId, programId);
        if (!deleted) {
            res.status(404).json({ error: "Override no encontrado" });
            return;
        }

        res.json({ success: true });
    } catch (error) {
        console.error("[Editorial] Error al borrar el override:", error);
        res.status(500).json({ error: "Error al borrar el override editorial" });
    }
});

// ------------------------------------------------------------------
// GET /api/editorial/programs — programas del tenant (id + nombre) para
// el selector de overrides en la UI.
// ------------------------------------------------------------------
editorialRouter.get("/programs", requireAuth, async (req: Request, res: Response) => {
    try {
        const tenantId = req.auth!.tenantId;
        const items = await listPrograms(editorialStore(), tenantId);
        res.json({ items });
    } catch (error) {
        console.error("[Editorial] Error al listar programas:", error);
        res.status(500).json({ error: "Error al obtener los programas" });
    }
});
