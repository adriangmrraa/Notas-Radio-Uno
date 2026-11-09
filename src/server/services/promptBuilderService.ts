import { getEffectiveProfile, DEFAULT_EDITORIAL_PROFILE, type EffectiveProfile } from './editorialProfileService.js';

// ---------------------------------------------------------------------------
// promptBuilderService — ÚNICO choke-point de prompts de generación (T-29)
//
// Todo prompt de generación (nota, copy por red, detección de momentos, título,
// edición asistida) se construye acá con el perfil editorial efectivo
// (programa → tenant → default) + contexto de personas/programa.
// Ningún servicio arma prompts con tono/reglas por su cuenta.
//
// Uso: const { system, user, profileVersion } = await build({...});
//      → chatCompletion({ systemPrompt: system, userPrompt: user, ... })
//      → guardar profileVersion en el asset generado (auditoría editorial).
// ---------------------------------------------------------------------------

const PLATFORM_NAME = process.env.PLATFORM_NAME || 'Noticias';

export type PromptKind = 'nota' | 'copy' | 'titulo' | 'edit' | 'moments';

// ── Base prompts (movidos desde newsService / clipService / review / contentMultiplier)
export const TONE_PROMPTS: Record<string, string> = {
    formal:
        'Tono FORMAL: lenguaje institucional, preciso y sobrio. Oraciones estructuradas con sujeto-verbo-predicado claro. Evitar coloquialismos. Citar fuentes con nombre y cargo cuando esten disponibles.',
    informal:
        "Tono INFORMAL: lenguaje cercano y accesible sin perder rigurosidad periodistica. Permitir expresiones coloquiales argentinas ('se viene', 'pega fuerte'). Mantener datos duros pero explicarlos con naturalidad.",
    urgente:
        "Tono ULTIMO MOMENTO: maxima inmediatez. Oraciones cortas y punzantes. Arrancar con el hecho duro. Usar presente indicativo ('confirman', 'anuncian'). Transmitir la gravedad sin sensacionalismo.",
    analitico:
        "Tono ANALITICO: contextualizar cada hecho con antecedentes y consecuencias. Relacionar con tendencias mas amplias. Incluir perspectivas multiples. Usar lenguaje reflexivo ('esto implica que', 'en el marco de').",
    humor:
        'Tono HUMOR: lenguaje desenfadado con guiños al oyente, sin perder el dato duro. Remates cortos, ironía medida, nunca burla al protagonista.',
    duro:
        'Tono DURO: confrontación directa, preguntas incómodas, lenguaje afilado pero preciso. Datos primero, adjetivos medidos.',
    fan:
        'Tono FAN: pasión de tribuna. Exageración celebratoria, identificación con la audiencia ("nosotros"), emoción explícita sobre el acontecimiento.',
};

export const STRUCTURE_PROMPTS: Record<string, string> = {
    flash:
        'FLASH INFORMATIVO: Exactamente 2-3 oraciones. Primera oracion = hecho + protagonista + lugar. Segunda = dato complementario o consecuencia inmediata. Sin introduccion ni cierre.',
    corta:
        'NOTA CORTA: Un parrafo de 4-5 oraciones. Abrir con el hecho principal respondiendo que-quien-donde. Desarrollar con un dato de contexto. Cerrar con impacto o proyeccion.',
    completa:
        'NOTA COMPLETA: 3-4 parrafos. P1: Lead informativo (que, quien, cuando, donde, por que). P2: Desarrollo con detalles, cifras y declaraciones. P3: Contexto y antecedentes relevantes. P4 (opcional): Reacciones o proyeccion futura.',
    cronica:
        'CRONICA: 4-5 parrafos narrativos. Abrir con la escena o momento mas impactante (in medias res). Desarrollar cronologicamente incorporando voces directas entre comillas. Incluir descripciones del ambiente. Cerrar con una reflexion que conecte con el lector.',
};

const SYSTEM_NEWS = `Sos un periodista senior de ${PLATFORM_NAME}. Tu trabajo es redactar notas periodisticas precisas y profesionales.

DIRECTRICES EDITORIALES:
- Escribis para una audiencia general interesada en noticias verificables
- Usa espanol rioplatense (vos, tenes) pero sin exceso de lunfardo
- Atribui toda declaracion a su fuente ("segun X", "X afirmo que")
- Nunca inventes declaraciones ni datos que no esten en la transcripcion
- Si hay cifras, verifica que sean coherentes dentro del texto
- No uses muletillas periodisticas vacias ("cabe destacar", "es importante senalar")
- Evita adjetivos valorativos salvo en cronicas: deja que los hechos hablen
- Si la informacion es incompleta, escribi con lo que hay sin rellenar con especulacion

FORMATO:
- No incluyas encabezados, metadatos ni etiquetas
- Solo el texto de la nota, listo para publicar
- No uses markdown ni formato especial`;

const SYSTEM_TITLE = `Sos el editor de titulares de ${PLATFORM_NAME}. Tu trabajo es crear titulos periodisticos que capten la atencion en redes sociales y placas informativas.

REGLAS PARA TITULARES:
- Maximo 10 palabras, idealmente 6-8
- Usar verbos en presente indicativo (confirman, anuncian, denuncian, lanzan)
- Incluir el sujeto principal (quien) y la accion (que)
- Si hay dato numerico impactante, incluirlo
- No usar signos de pregunta ni exclamacion
- No usar "ULTIMO MOMENTO" ni "URGENTE" (eso va en la placa, no en el titulo)
- Priorizar claridad sobre creatividad
- Si es relevante, incluir la referencia geografica
- Solo el titulo, sin comillas ni explicacion`;

const SYSTEM_COPY = `Sos un social media manager senior de ${PLATFORM_NAME}. Tu trabajo es adaptar notas periodisticas a cada plataforma social maximizando engagement sin perder rigurosidad.

- Escribis en espanol rioplatense
- Nunca inventes datos que no esten en la nota
- Cada plataforma tiene su gramatica: respetala
- Devolves SOLO JSON valido, sin texto adicional`;

const SYSTEM_EDIT = `Sos un editor periodistico senior de ${PLATFORM_NAME}. Tu trabajo es modificar notas segun las instrucciones del usuario, manteniendo rigurosidad y estilo editorial.

- No inventes datos que no esten en la nota original
- Respetá la intención del pedido del usuario
- Devolvés SOLO JSON valido`;

const SYSTEM_MOMENTS = `Sos un productor de contenido viral experto en redes sociales de ${PLATFORM_NAME}.

Tu trabajo es encontrar los momentos mas impactantes, virales o compartibles dentro de una transcripcion de un programa en vivo. Respondes SOLO con JSON valido.`;

// ---------------------------------------------------------------------------
// Bloque editorial — inyecta el perfil efectivo en el system prompt.
// ---------------------------------------------------------------------------
function renderRuleValue(value: unknown): string {
    if (Array.isArray(value)) return value.map(String).join(', ');
    if (value && typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

export function renderEditorialBlock(profile: EffectiveProfile, opts: { persons?: string | null; programName?: string | null } = {}): string {
    const parts: string[] = [];

    // Tono: key conocida → prompt canónico; string libre → descripción directa.
    const toneInstruction = TONE_PROMPTS[profile.tone] ?? `Tono ${String(profile.tone).toUpperCase()}.`;
    parts.push(`LINEA EDITORIAL DEL CANAL:\n- ${toneInstruction}`);

    if (profile.rubro) parts.push(`- Rubro/vertical: ${profile.rubro}`);
    if (profile.audience) parts.push(`- Audiencia: ${profile.audience}`);

    const rules = profile.rules ?? {};
    const ruleKeys = Object.keys(rules);
    if (ruleKeys.length > 0) {
        const lines = ruleKeys.map((k) => `  - ${k}: ${renderRuleValue(rules[k])}`);
        parts.push(`- Reglas editoriales (obligatorias):\n${lines.join('\n')}`);
    }

    if (profile.toneExamples.length > 0) {
        const ex = profile.toneExamples.slice(0, 5).map((e) => `  - "${e}"`).join('\n');
        parts.push(`- Ejemplos del estilo del canal (imitar registro, NO copiar):\n${ex}`);
    }

    if (opts.programName) parts.push(`- Programa actual: "${opts.programName}" (referenciarlo cuando aplique)`);
    if (opts.persons) parts.push(`- Personas del programa (contexto para atribuir y mencionar):\n${opts.persons}`);

    return `\n\n${parts.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Contexto por kind
// ---------------------------------------------------------------------------
export interface PromptBuildInput {
    /** Sin tenantId → default de plataforma (version 0). */
    tenantId?: string | null;
    programId?: string | null;
    kind: PromptKind;
    context: {
        /** Override explícito del caller (pipelineConfig.tone); si no viene, manda el perfil. */
        tone?: string;
        // nota / titulo / moments
        transcription?: string;
        /** 'nota': estructura elegida en pipelineConfig (no es del perfil). */
        structure?: string;
        webContext?: string;
        insights?: string;
        context?: string;
        // copy / edit
        title?: string;
        content?: string;
        /** copy: instrucción de variante (regenerateVariant). */
        variantInstruction?: string;
        customInstruction?: string;
        /** edit: pedido del usuario. */
        instruction?: string;
        /** moments: timeline de utterances `[12s - 15s] A: texto`. */
        timeline?: string;
        /** Enriquecimiento común: personas del programa (ya formateado). */
        persons?: string | null;
        programName?: string | null;
    };
}

export interface BuiltPrompt {
    system: string;
    user: string;
    /** Versión del perfil editorial aplicada (0 = default plataforma). */
    profileVersion: number;
}

export async function build(input: PromptBuildInput): Promise<BuiltPrompt> {
    const resolved = input.tenantId
        ? await getEffectiveProfile(input.tenantId, input.programId ?? null)
        : null;
    const profile: EffectiveProfile = resolved ?? {
        ...DEFAULT_EDITORIAL_PROFILE,
        version: 0,
        sources: { profile: 'default', overriddenFields: [] },
    };
    // Override de tono explícito del caller (config del pipeline) — las reglas,
    // audiencia y resto del perfil efectivo se mantienen.
    if (input.context.tone) profile.tone = input.context.tone;
    const ctx = input.context;
    const editorial = renderEditorialBlock(profile, {
        persons: ctx.persons,
        programName: ctx.programName,
    });

    let system: string;
    let user: string;

    switch (input.kind) {
        case 'nota': {
            const structureInstruction = STRUCTURE_PROMPTS[ctx.structure ?? 'completa'] ?? STRUCTURE_PROMPTS.completa;
            system = SYSTEM_NEWS + editorial + `\n\n${structureInstruction}`;

            user = `TRANSCRIPCION DE LA TRANSMISION EN VIVO:
"""
${ctx.transcription ?? ''}
"""`;
            if (ctx.insights) {
                user += `\n\nANALISIS EDITORIAL (insights extraidos automaticamente):\n"""\n${ctx.insights}\n"""`;
            }
            if (ctx.webContext) {
                user += `\n\nINFORMACION COMPLEMENTARIA DE FUENTES WEB (usar para enriquecer y contextualizar, citando la fuente):\n"""\n${ctx.webContext}\n"""`;
            }
            if (ctx.context) {
                user += `\n\nCONTEXTO ADICIONAL DEL EDITOR:\n"""\n${ctx.context}\n"""`;
            }
            user += `\n\nRedacta la nota periodistica ahora.`;
            break;
        }

        case 'titulo': {
            system = SYSTEM_TITLE + editorial;
            user = `Transcripcion: ${(ctx.transcription ?? '').slice(0, 600)}\nInsights: ${ctx.insights ?? ''}\n\nGenera UN SOLO titulo:`;
            break;
        }

        case 'copy': {
            system = SYSTEM_COPY + editorial;
            if (ctx.variantInstruction) {
                // Regeneración de una variante puntual
                user = `Tenés esta nota periodística:

Título: ${ctx.title ?? ''}
Nota: ${ctx.content ?? ''}

Generá ${ctx.variantInstruction}${ctx.customInstruction ?? ''}

Solo el JSON, sin texto adicional.`;
            } else {
                user = `A partir de esta nota periodística, generá versiones optimizadas para cada plataforma.

Título: ${ctx.title ?? ''}
Nota: ${ctx.content ?? ''}
Tono: ${profile.tone}

Generá un JSON con exactamente esta estructura:
{
  "twitterThread": ["tweet 1 (max 280 chars)", "tweet 2", "tweet 3"],
  "instagramCarousel": ["Slide 1 texto", "Slide 2", "Slide 3", "Slide 4", "Slide 5"],
  "linkedinPost": "Post completo para LinkedIn (profesional, 300-500 palabras)",
  "youtubeDescription": "Descripción para YouTube con timestamps y keywords SEO",
  "newsletterBlurb": "Resumen para newsletter (2-3 párrafos, enganche + link)"
}

Reglas estrictas:
- Twitter: máximo 5 tweets, cada uno ≤280 caracteres, usá emojis moderadamente, primer tweet debe enganchar
- Instagram: 5-7 slides, texto conciso por slide, primer slide = hook, último slide = CTA
- LinkedIn: tono profesional, incluí datos duros, cerrá con pregunta para engagement
- YouTube: incluí keywords SEO, estructura con timestamps ficticios (ej: 0:00, 1:30, etc.)
- Newsletter: tono cercano, como si le escribieras a un suscriptor, cerrá con call to action
- Todo en español rioplatense
- Solo el JSON, sin texto adicional`;
            }
            break;
        }

        case 'edit': {
            system = SYSTEM_EDIT + editorial;
            user = `Tenés esta nota:

Título: ${ctx.title ?? ''}
Contenido: ${ctx.content ?? ''}

El usuario pidió: "${ctx.instruction ?? ''}"

Devolvé el título y contenido modificados en formato JSON: { "title": "...", "content": "..." }`;
            break;
        }

        case 'moments': {
            system = SYSTEM_MOMENTS + editorial;
            user = `Analizá esta transcripción de un programa de radio/TV y encontrá los 1-3 momentos más impactantes, virales o compartibles.

TRANSCRIPCIÓN:
${(ctx.transcription ?? '').slice(0, 3000)}

LÍNEA DE TIEMPO (utterances con timestamps en ms):
${ctx.timeline ?? ''}

Para cada momento identificá:
- startMs: tiempo de inicio en milisegundos
- endMs: tiempo de fin en milisegundos (el clip debe durar entre 15.000ms y 60.000ms)
- hookText: frase gancho corta y poderosa para usar como título del clip (máximo 80 caracteres)
- reason: por qué este momento es viral o impactante (1 oración)

IMPORTANTE: Los timestamps deben venir de la línea de tiempo de utterances proporcionada. Si no hay utterances, estimá basándote en el texto (promediá ~150 palabras por minuto).

Respondé SOLO con JSON válido en este formato:
{
  "clips": [
    { "startMs": 0, "endMs": 30000, "hookText": "...", "reason": "..." }
  ]
}`;
            break;
        }
    }

    return { system, user, profileVersion: profile.version };
}
